import { readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import type { AnyRelations } from "drizzle-orm/relations";

const adminHTMLPath = new URL("../../dist/admin/index.html", import.meta.url);
const adminAssetsDir = new URL("../../dist/admin/", import.meta.url);

import pkg from "../../package.json";
import { handleAdminApi, pushRequestLog } from "../admin/routes.ts";
import { errorResponse } from "../api/helpers.ts";
import type { AuthUser } from "../api/types.ts";
import { createAccountDeletionRoutes } from "../auth/account-deletion.ts";
import { createApiKeyRoutes } from "../auth/api-keys.ts";
import { isCsrfExempt, validateCsrf } from "../auth/csrf.ts";
import { createEmailRoutes } from "../auth/email.ts";
import { createGuestRoutes } from "../auth/guest.ts";
import { createInvitationRoutes } from "../auth/invitations.ts";
import { createJwtRoutes } from "../auth/jwt/routes.ts";
import { createTotpRoutes } from "../auth/mfa/totp.ts";
import { extractAuth as extractAuthFromReq, isBearerOnly } from "../auth/middleware.ts";
import { createOAuthRoutes } from "../auth/oauth/routes.ts";
import { createOrganizationRoutes } from "../auth/organizations/routes.ts";
import { createPasskeyRoutes } from "../auth/passkeys.ts";
import { createPasswordlessRoutes } from "../auth/passwordless.ts";
import { hashPassword } from "../auth/passwords.ts";
import { createAuthRoutes } from "../auth/routes.ts";
import { createSessionManagementRoutes } from "../auth/session-management.ts";
import { createSmsOtpRoutes } from "../auth/sms/routes.ts";
import type { SmsTransport } from "../auth/sms/types.ts";
import { addCorsHeaders, handleCorsPreflightOrNull } from "../cors.ts";
import { generateAllCrudHandlers } from "../crud/handler.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import type { TableHooks } from "../hooks/types.ts";
import { JobScheduler } from "../jobs/scheduler.ts";
import type { JobDefinition } from "../jobs/types.ts";
import type { Mailer } from "../mailer/index.ts";
import { handleWebSocketClose, handleWebSocketMessage } from "../realtime/handler.ts";
import { RealtimeManager } from "../realtime/manager.ts";
import { PresenceTracker } from "../realtime/presence.ts";
import type { TableRules } from "../rules/types.ts";
import { createFilesContext, type FilesContext } from "../storage/files-context.ts";
import { createFileRoutes, createStorageDriver } from "../storage/routes.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { validateUsersTable } from "./bootstrap.ts";
import type { BunBaseConfig } from "./config.ts";
import { type ResolvedConfig, resolveConfig } from "./config.ts";
import { createDatabase, runUserMigrations } from "./database.ts";
import type { AnyDb } from "./db-types.ts";
import type { InternalSchema } from "./internal-schema.ts";
import { getInternalSchema } from "./internal-schema.ts";

/**
 * BunBase server composition and request orchestration.
 * @module
 */

/** Internal routing key attached to ws.data for dispatching to the correct extend handler. */
const WS_PATH_KEY = "__bunbase_ws_path" as const;

/** Per-path WebSocket definition provided by the consumer via extend. */
export interface ExtendWebSocketDef<TData = Record<string, never>> {
  /** Called on HTTP upgrade request. Return data to attach to ws.data, or a Response to reject the upgrade. */
  upgrade?: (req: Request) => TData | Response | Promise<TData | Response>;
  open?: (ws: ServerWebSocket<TData>) => void | Promise<void>;
  message: (ws: ServerWebSocket<TData>, message: string | Buffer) => void | Promise<void>;
  close?: (ws: ServerWebSocket<TData>, code: number, reason: string) => void | Promise<void>;
  error?: (ws: ServerWebSocket<TData>, error: Error) => void | Promise<void>;
  idleTimeout?: number;
  maxPayloadLength?: number;
}

/** Identity function for TypeScript inference of ws.data type. Consistent with defineRules/defineHooks. */
export function defineWebSocket<TData>(def: ExtendWebSocketDef<TData>): ExtendWebSocketDef<TData> {
  return def;
}

export type RouteHandlers = Record<string, (req: Request) => Response | Promise<Response>>;

export type RouteDefinition = RouteHandlers & {
  websocket?: ExtendWebSocketDef<any>;
  /**
   * When `true`, the route is exempt from the `/api/` prefix requirement.
   * Unscoped routes do not receive CSRF protection — use for OAuth endpoints,
   * well-known URIs, file downloads, and other externally-consumed paths.
   */
  unscoped?: boolean;
};

export type RouteMap = Record<string, RouteDefinition>;

/** Context passed to `extend` route builders. */
export interface ExtendContext {
  db: AnyDb;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
  files: FilesContext;
}

/**
 * Options for creating a BunBase server.
 *
 * @remarks
 * `relations` is separate from `schema` because Drizzle relation metadata is a
 * distinct object produced by `defineRelations(schema, ...)`. Pass both when
 * using `expand` on CRUD endpoints.
 */
export interface CreateServerOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  schema: TSchema;
  relations?: AnyRelations;
  rules?: Record<string, TableRules>;
  hooks?: Record<string, TableHooks>;
  authHooks?: AuthHooks;
  jobs?: JobDefinition[];
  config?: BunBaseConfig;
  extend?: (ctx: ExtendContext) => RouteMap;
  /**
   * Optional mailer for sending auth emails (password reset, email verification).
   * When provided, password reset emails are sent directly instead of via the webhook.
   * Email verification emails are sent automatically on registration when the users
   * table has an `emailVerified` column and `auth.emailVerification.autoSend` is true.
   */
  mailer?: Mailer;
  /**
   * Optional SMS transport for phone-based OTP authentication.
   */
  smsTransport?: SmsTransport;
}

/** Runtime BunBase server instance. */
export interface BunBaseServer {
  db: AnyDb;
  adapter: DatabaseAdapter;
  config: ResolvedConfig;
  listen: (port?: number) => ReturnType<typeof Bun.serve>;
}

/**
 * Create a BunBase server from schema, rules, and config.
 *
 * @param options Server options containing schema, rules, hooks, routes, and config.
 * @returns A BunBase server with `listen()`, `db`, `adapter`, and resolved `config`.
 *
 * @example
 * ```ts
 * const rules = defineRules({ tasks: { list: () => null, create: ({ auth }) => !!auth } });
 * const server = createServer({ schema, relations, rules });
 * server.listen(3000);
 * ```
 */
export function createServer(options: CreateServerOptions): BunBaseServer {
  const tableRules = options.rules as Record<string, TableRules> | undefined;
  const tableHooks = options.hooks as Record<string, TableHooks> | undefined;
  const authHooks = options.authHooks;

  // Validate job names synchronously so misconfiguration is a deterministic startup error
  if (options.jobs && options.jobs.length > 0) {
    const seen = new Set<string>();
    for (const job of options.jobs) {
      if (seen.has(job.name)) {
        throw new Error(`[BunBase] Duplicate job name: "${job.name}"`);
      }
      seen.add(job.name);
    }
  }

  const config = resolveConfig(options.config);

  // Resolve service key: config/env → persisted file → auto-generate
  if (!config.serviceKey) {
    const keyFilePath = ".bunbase-service-key";
    try {
      const content = readFileSync(keyFilePath, "utf-8").trim();
      if (content.startsWith("bb_sk_") && content.length === 37) {
        config.serviceKey = content;
      }
    } catch {
      // File doesn't exist or isn't readable — will generate below
    }

    if (!config.serviceKey) {
      const randomBytes = new Uint8Array(16);
      crypto.getRandomValues(randomBytes);
      const hex = Array.from(randomBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      config.serviceKey = `bb_sk_${hex}`;
      try {
        writeFileSync(keyFilePath, config.serviceKey);
      } catch (err) {
        console.warn(
          `  \x1b[33m[BunBase]\x1b[0m Warning: Could not persist service key to ${keyFilePath}:`,
          err,
        );
      }
    }
  }

  const { db, dialect, adapter } = createDatabase(config, options.schema, options.relations);
  const internalSchema = getInternalSchema(dialect);

  // Bootstrap internal tables (DDL via adapter)
  let bootstrapped = false;
  const bootstrapPromise = (async () => {
    await adapter.bootstrapInternalTables();

    // Migrate user-defined tables from Drizzle migrations
    await runUserMigrations(db, config);

    // Validate users table if provided
    const usersTable = validateUsersTable(options.schema);

    // Seed default admin if users table exists and no admin user exists.
    // Pass whether development mode was explicitly requested so that a
    // misconfigured production environment (NODE_ENV not set) does not
    // accidentally seed predictable credentials.
    if (usersTable) {
      const devExplicit =
        options.config?.development === true || process.env.NODE_ENV === "development";
      await seedDefaultAdmin(db, usersTable, config.development, devExplicit);
    }

    bootstrapped = true;
    return usersTable;
  })();

  let usersTable: any = null;

  try {
    usersTable = validateUsersTable(options.schema);
  } catch {
    // Will be caught again during bootstrap
  }

  // Auth extractor with admin impersonation support
  const extractAuth = async (req: Request): Promise<AuthUser | null> => {
    const realUser = await extractAuthFromReq(
      req,
      db,
      internalSchema,
      usersTable,
      config.serviceKey,
    );

    // Admin impersonation — only honoured when caller is a verified admin
    const impersonateId = req.headers.get("x-impersonate-user");
    if (impersonateId && realUser?.role === "admin") {
      const targetUser = await adapter.rawQueryOne<Record<string, unknown>>(
        "SELECT * FROM users WHERE id = $id",
        { $id: impersonateId },
      );
      if (targetUser) {
        return targetUser as unknown as AuthUser;
      }
    }

    return realUser;
  };

  // Realtime manager + broadcast shim (only when realtime is enabled)
  let realtimeManager: RealtimeManager | undefined;
  let realtimePresence: PresenceTracker | undefined;
  let broadcastFn:
    | ((t: string, a: "INSERT" | "UPDATE" | "DELETE", r: Record<string, unknown>) => void)
    | undefined;

  if (config.realtime.enabled) {
    realtimeManager = new RealtimeManager(db, options.schema, tableRules);
    realtimePresence = new PresenceTracker();
    broadcastFn = (t, a, r) => {
      realtimeManager?.broadcastTableChange(t, a, r).catch((err) => {
        console.error("[BunBase] Realtime broadcast error:", err);
      });
    };
  }

  // Generate CRUD REST handlers from schema with rules and hooks
  const { exact: crudExact, pattern: crudPattern } = generateAllCrudHandlers(
    options.schema,
    db,
    extractAuth,
    tableRules,
    tableHooks,
    broadcastFn,
  );

  // Collect known CRUD table names for descriptive 404 messages
  const knownApiTables = new Set(Object.keys(crudExact).map((p) => p.replace(/^\/api\//, "")));

  // Build auth route handlers
  const authRoutes = createAuthRoutes({
    db,
    internalSchema,
    config,
    usersTable: usersTable as any,
    authHooks,
    mailer: options.mailer,
  });
  const emailRoutes = createEmailRoutes({
    db,
    internalSchema,
    config,
    usersTable,
    authHooks,
    mailer: options.mailer,
  });
  const oauthRoutes = createOAuthRoutes({
    db,
    internalSchema,
    config,
    usersTable,
    authHooks,
  });
  const fileRoutes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config,
    schema: options.schema,
    rules: tableRules,
    usersTable,
  });

  const apiKeyRoutes = createApiKeyRoutes({
    db,
    internalSchema,
    config,
    usersTable,
    extractAuth,
  });

  // Passwordless auth routes (magic link + OTP, only when enabled)
  const passwordlessRoutes =
    config.auth.mfa.magicLink.enabled || config.auth.mfa.otp.enabled
      ? createPasswordlessRoutes({
          db,
          internalSchema,
          config,
          usersTable,
          authHooks,
          mailer: options.mailer,
        })
      : {};

  // TOTP MFA routes (only when enabled)
  const totpRoutes = config.auth.mfa.totp.enabled
    ? createTotpRoutes({
        db,
        internalSchema,
        config,
        usersTable,
        extractAuth,
        authHooks,
      })
    : {};

  // Passkey routes (only when enabled)
  const passkeyRoutes = config.auth.mfa.passkeys.enabled
    ? createPasskeyRoutes({
        db,
        internalSchema,
        config,
        usersTable,
        extractAuth,
        authHooks,
      })
    : {};

  // Session management routes
  const sessionManagementRoutes = createSessionManagementRoutes({
    db,
    internalSchema,
    config,
    extractAuth,
  });

  // Account deletion routes (enabled by default)
  const accountDeletionRoutes = config.auth.accountDeletion.enabled
    ? createAccountDeletionRoutes({
        db,
        internalSchema,
        config,
        usersTable,
        extractAuth,
        authHooks,
      })
    : {};

  // Guest auth routes (only when enabled)
  const guestRoutes = config.auth.guestAuth.enabled
    ? createGuestRoutes({
        db,
        internalSchema,
        config,
        usersTable,
        authHooks,
      })
    : {};

  // SMS OTP routes (only when enabled)
  const smsOtpRoutes = config.auth.mfa.smsOtp.enabled
    ? createSmsOtpRoutes({
        db,
        internalSchema,
        config,
        usersTable,
        smsTransport: options.smsTransport,
        authHooks,
      })
    : {};

  // Invitation routes (only when enabled)
  const invitationRoutes = config.auth.invitations.enabled
    ? createInvitationRoutes({
        db,
        internalSchema,
        config,
        extractAuth,
        authHooks,
      })
    : {};

  // Organization routes (only when enabled)
  const organizationRoutes = config.auth.organizations.enabled
    ? createOrganizationRoutes({
        db,
        internalSchema,
        config,
        extractAuth,
        authHooks,
      })
    : {};

  // JWT routes (only when enabled)
  const jwtRoutes = config.auth.jwt.enabled
    ? createJwtRoutes({
        db,
        internalSchema,
        config,
        usersTable,
      })
    : {};

  // Store JWT config on globalThis for middleware JWT detection
  if (config.auth.jwt.enabled) {
    (globalThis as any).__bunbaseJwtConfig = config.auth.jwt;
  }

  // Storage driver for admin operations
  const adminStorage = createStorageDriver(config);

  // Merge all HTTP routes into a lookup map
  const httpRoutes: RouteMap = {};

  for (const routeSet of [
    authRoutes,
    emailRoutes,
    oauthRoutes,
    fileRoutes,
    apiKeyRoutes,
    passwordlessRoutes,
    totpRoutes,
    passkeyRoutes,
    sessionManagementRoutes,
    accountDeletionRoutes,
    guestRoutes,
    smsOtpRoutes,
    invitationRoutes,
    organizationRoutes,
    jwtRoutes,
    crudExact,
  ]) {
    for (const [path, handlers] of Object.entries(routeSet)) {
      httpRoutes[path] = handlers as Record<string, (req: Request) => Response | Promise<Response>>;
    }
  }

  // Merge extend routes (if provided)
  // HTTP-only extend routes must live under /api/* so CORS/CSRF protections apply.
  // WebSocket routes are exempt from the /api/ prefix requirement since WebSocket
  // connections require explicit new WebSocket() calls and aren't CSRF-vulnerable.
  const extendWsRoutes = new Map<string, ExtendWebSocketDef<any>>();
  const unscopedPaths: string[] = [];

  // Reserved path prefixes that unscoped routes must not collide with
  const reservedPrefixes = ["/health", "/_admin", "/auth/", "/realtime", "/files/"];

  if (options.extend) {
    const filesContext = createFilesContext(db, adminStorage, internalSchema.files);
    const extendRoutes = options.extend({ db, extractAuth, files: filesContext });
    for (const [path, definition] of Object.entries(extendRoutes)) {
      const { websocket, unscoped, ...httpHandlers } = definition;
      const hasHttp = Object.keys(httpHandlers).length > 0;

      if (hasHttp) {
        if (!unscoped && !path.startsWith("/api/")) {
          throw new Error(
            `BunBase: extend routes must be under /api/. Got: "${path}". ` +
              "This ensures CSRF protection is applied automatically. " +
              "Use `unscoped: true` to opt out of this requirement.",
          );
        }
        if (unscoped) {
          for (const prefix of reservedPrefixes) {
            if (path === prefix || path.startsWith(prefix)) {
              throw new Error(
                `BunBase: unscoped extend route "${path}" collides with reserved path "${prefix}".`,
              );
            }
          }
        }
        if (httpRoutes[path]) {
          throw new Error(`BunBase: Cannot merge extend routes due to path collision: ${path}`);
        }
        if (crudPattern[path]) {
          throw new Error(
            `BunBase: Cannot merge extend routes due to path collision with CRUD item route: ${path}`,
          );
        }
        httpRoutes[path] = httpHandlers;
        if (unscoped) unscopedPaths.push(path);
      }

      if (websocket) {
        if (path === "/realtime") {
          throw new Error("BunBase: Cannot override built-in /realtime WebSocket endpoint.");
        }
        if (extendWsRoutes.has(path)) {
          throw new Error(`BunBase: Duplicate WebSocket path: ${path}`);
        }
        extendWsRoutes.set(path, websocket);
      }
    }
  }

  // SEC-002: Warn about CRUD tables where any operation has no rule defined.
  // A missing rule defaults to deny (403), so uncovered operations are inaccessible until rules are added.
  // "get" and "view" are aliases — either one covers single-record reads.
  for (const path of Object.keys(crudExact)) {
    const tableName = path.replace(/^\/api\//, "");
    const tableRule = tableRules?.[tableName];
    const uncovered: string[] = [];
    if (!tableRule?.list) uncovered.push("list");
    if (!tableRule?.get && !tableRule?.view) uncovered.push("get");
    if (!tableRule?.create) uncovered.push("create");
    if (!tableRule?.update) uncovered.push("update");
    if (!tableRule?.delete) uncovered.push("delete");
    if (uncovered.length > 0) {
      console.warn(
        `  \x1b[33m[BunBase]\x1b[0m Warning: table "${tableName}" has no rule for [${uncovered.join(", ")}] — ${uncovered.length === 5 ? "all operations are" : "these operations are"} denied by default. Use \`allowAll\` to explicitly allow public access.`,
      );
    }
  }

  // Pattern-based routes (with path params)
  const patternRoutes: Array<{
    pattern: RegExp;
    handlers: Record<string, (req: Request) => Response | Promise<Response>>;
  }> = [];

  // Convert Express-style :param routes from httpRoutes to regex patterns
  for (const [path, handlers] of Object.entries(httpRoutes)) {
    if (path.includes(":")) {
      const regex = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`);
      patternRoutes.push({
        pattern: regex,
        handlers: handlers as Record<string, (req: Request) => Response | Promise<Response>>,
      });
      delete httpRoutes[path];
    }
  }

  // Add CRUD item routes (/api/{table}/:id) to patternRoutes
  for (const [path, handlers] of Object.entries(crudPattern)) {
    const regex = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`);
    patternRoutes.push({ pattern: regex, handlers });
  }

  function listen(port?: number) {
    const envPort = Number(process.env.PORT);
    const resolvedPort =
      port !== undefined ? port : Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;

    // Job scheduler — starts once bootstrap completes
    let scheduler: JobScheduler | null = null;
    if (options.jobs && options.jobs.length > 0) {
      scheduler = new JobScheduler(db);
      (async () => {
        try {
          await bootstrapPromise;
          scheduler?.start(options.jobs!);
        } catch (err) {
          console.error("[BunBase] Failed to start job scheduler:", err);
        }
      })();
    }

    // Mutable server reference needed by WS handlers for server.publish()
    let bunServer: ReturnType<typeof Bun.serve>;

    // Unified WebSocket handler — dispatches to extend WS routes or realtime based on ws.data.
    // Bun.serve() only allows one `websocket` handler object, so all WS connections share it.
    const hasAnyWebSockets = !!(realtimeManager && realtimePresence) || extendWsRoutes.size > 0;

    // Merge WS configs — use most permissive values since Bun allows only one config
    let wsIdleTimeout = 120;
    let wsMaxPayloadLength = 16 * 1024 * 1024;
    for (const def of extendWsRoutes.values()) {
      if (def.idleTimeout !== undefined) wsIdleTimeout = Math.max(wsIdleTimeout, def.idleTimeout);
      if (def.maxPayloadLength !== undefined)
        wsMaxPayloadLength = Math.max(wsMaxPayloadLength, def.maxPayloadLength);
    }

    const websocketHandlers = hasAnyWebSockets
      ? {
          open(ws: any) {
            if (WS_PATH_KEY in ws.data) {
              extendWsRoutes.get(ws.data[WS_PATH_KEY])?.open?.(ws);
            }
          },
          async message(ws: any, raw: string | Buffer) {
            if (WS_PATH_KEY in ws.data) {
              await extendWsRoutes.get(ws.data[WS_PATH_KEY])?.message(ws, raw);
            } else if (realtimeManager && realtimePresence) {
              await handleWebSocketMessage(ws, raw, bunServer, realtimeManager, realtimePresence);
            }
          },
          close(ws: any, code: number, reason: string) {
            if (WS_PATH_KEY in ws.data) {
              extendWsRoutes.get(ws.data[WS_PATH_KEY])?.close?.(ws, code, reason);
            } else if (realtimeManager && realtimePresence) {
              handleWebSocketClose(ws, bunServer, realtimeManager, realtimePresence);
            }
          },
          error(ws: any, error: Error) {
            if (WS_PATH_KEY in ws.data) {
              extendWsRoutes.get(ws.data[WS_PATH_KEY])?.error?.(ws, error);
            }
          },
          idleTimeout: wsIdleTimeout,
          maxPayloadLength: wsMaxPayloadLength,
        }
      : undefined;

    // Extract main request handler as a named function so the SPA catch-all
    // route forwarders can call it without duplicating the handler body in a route.
    async function masterFetch(req: Request, srv: ReturnType<typeof Bun.serve>): Promise<Response> {
      // Capture socket IP before any cloning — srv.requestIP() needs the original request.
      const socketIp = srv.requestIP(req)?.address ?? "unknown";

      // Ensure bootstrap is complete (important for Postgres)
      if (!bootstrapped) {
        const bootstrapResult = await bootstrapPromise;
        if (bootstrapResult && !usersTable) {
          usersTable = bootstrapResult;
        }
      }

      const start = Date.now();

      // CORS preflight
      const preflight = handleCorsPreflightOrNull(req, config);
      if (preflight) return preflight;

      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade for /realtime — must use the original req, not a clone,
      // because srv.upgrade() requires the native Bun request handle.
      if (pathname === "/realtime" && config.realtime.enabled && realtimeManager) {
        const auth = await extractAuthFromReq(
          req,
          db,
          internalSchema,
          usersTable,
          config.serviceKey,
        ).catch(() => null);
        const upgraded = srv.upgrade(req, {
          data: {
            auth,
            connectedAt: Date.now(),
            presenceMeta: {},
          },
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // WebSocket upgrade for extend routes — also before request cloning.
      // Only attempt upgrade when the client sends the Upgrade: websocket header.
      const wsDef = extendWsRoutes.get(pathname);
      if (wsDef && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        let upgradeData: Record<string, unknown> = {};
        if (wsDef.upgrade) {
          const result = await wsDef.upgrade(req);
          if (result instanceof Response) return result;
          upgradeData = result as Record<string, unknown>;
        }
        const upgraded = srv.upgrade(req, {
          data: { ...upgradeData, [WS_PATH_KEY]: pathname },
        });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Inject socket IP header for all HTTP routes. Must happen after the WebSocket
      // paths above since cloning req would invalidate the native handle needed by srv.upgrade().
      // We always overwrite any client-provided value to prevent spoofing.
      const enrichedHeaders = new Headers(req.headers);
      enrichedHeaders.set("x-bunbase-socket-ip", socketIp);
      req = new Request(req, { headers: enrichedHeaders });

      // CSRF check for state-changing mutations — covers both /api/ and /_admin/api/.
      // Skipped for bearer-only requests (no session cookie present) since CSRF attacks
      // require the victim's browser to send cookies automatically.
      if (
        (pathname.startsWith("/api/") || pathname.startsWith("/_admin/api/")) &&
        ["POST", "PATCH", "DELETE"].includes(req.method) &&
        !isCsrfExempt(pathname) &&
        !isBearerOnly(req)
      ) {
        if (!validateCsrf(req)) {
          return addCorsHeaders(
            Response.json(
              { error: { code: "FORBIDDEN", message: "Invalid CSRF token" } },
              { status: 403 },
            ),
            req,
            config,
          );
        }
      }

      // Admin API — must be before CRUD/user routes
      if (pathname.startsWith("/_admin/api/")) {
        const response = await handleAdminApi(
          req,
          db,
          adapter,
          internalSchema,
          config,
          options.schema,
          adminStorage,
          usersTable,
        );
        const durationMs = Date.now() - start;
        const user = await extractAuthFromReq(
          req,
          db,
          internalSchema,
          usersTable,
          config.serviceKey,
        ).catch(() => null);
        await pushRequestLog(db, internalSchema, {
          id: Bun.randomUUIDv7(),
          method: req.method,
          path: pathname,
          status: response.status,
          durationMs,
          userId: user?.id ?? null,
          timestamp: new Date().toISOString(),
        });
        return addCorsHeaders(response, req, config);
      }

      // Exact match HTTP routes
      const routeHandlers = httpRoutes[pathname];
      if (routeHandlers) {
        const handler = routeHandlers[req.method];
        if (handler) {
          const response = await handler(req);
          await logRequest(db, internalSchema, req, pathname, start, response, null);
          return addCorsHeaders(response, req, config);
        }
        return addCorsHeaders(new Response("Method Not Allowed", { status: 405 }), req, config);
      }

      // Pattern match HTTP routes (file routes + CRUD item routes with params)
      for (const { pattern, handlers } of patternRoutes) {
        if (pattern.test(pathname)) {
          const handler = handlers[req.method];
          if (handler) {
            const response = await handler(req);
            await logRequest(db, internalSchema, req, pathname, start, response, null);
            return addCorsHeaders(response, req, config);
          }
          return addCorsHeaders(new Response("Method Not Allowed", { status: 405 }), req, config);
        }
      }

      // For /api/ paths, include available table names in the error to aid debugging
      let notFound: Response;
      if (pathname.startsWith("/api/")) {
        const tableSegment = pathname.slice(5).split("/")[0];
        if (tableSegment && !knownApiTables.has(tableSegment)) {
          const available = Array.from(knownApiTables).sort().join(", ");
          notFound = errorResponse(
            "NOT_FOUND",
            `Table '${tableSegment}' not found. Available tables: ${available || "(none)"}`,
            404,
          );
        } else {
          notFound = errorResponse("NOT_FOUND", "Route not found", 404);
        }
      } else {
        notFound = errorResponse("NOT_FOUND", "Route not found", 404);
      }
      await logRequest(db, internalSchema, req, pathname, start, notFound, null);
      return addCorsHeaders(notFound, req, config);
    }

    // When frontend.html is set, register API namespace forwarders so they win
    // over the SPA catch-all. Bun's router is specificity-based: /api/* beats /*.
    // Forwarders call masterFetch so the full auth/CSRF/logging pipeline applies.
    // Always-on routes: admin API + auth forwarded to masterFetch;
    // /_admin/* wildcard serves the SPA HTML directly (enables History API deep links).
    const baseAdminRoutes = {
      "/auth/*": (req: Request, srv: any) => masterFetch(req, srv),
      "/_admin/api/*": (req: Request, srv: any) => masterFetch(req, srv),
      "/_admin/*": () => new Response(Bun.file(adminHTMLPath)),
    };

    // Forward extend WS + unscoped paths so they reach masterFetch instead
    // of being swallowed by the SPA catch-all (/*).
    const extendForwards = Object.fromEntries(
      [...extendWsRoutes.keys(), ...unscopedPaths].map((path) => [
        path,
        (req: Request, srv: any) => masterFetch(req, srv),
      ]),
    );

    const frontendRoutes: Record<string, unknown> = config.frontend?.html
      ? {
          "/api/*": (req: Request, srv: any) => masterFetch(req, srv),
          "/files/*": (req: Request, srv: any) => masterFetch(req, srv),
          "/realtime": (req: Request, srv: any) => masterFetch(req, srv),
          ...extendForwards,
          // SPA catch-all — served via Bun's HTML bundler (HMR, TSX, CSS)
          "/*": config.frontend?.html,
        }
      : {};

    const server = Bun.serve({
      port: resolvedPort,

      routes: {
        "/health": Response.json({ status: "ok", version: pkg.version }),
        "/_admin": () => new Response(Bun.file(adminHTMLPath)),
        "/_admin/": () => new Response(Bun.file(adminHTMLPath)),
        "/_admin-assets/*": (req: any) => {
          const filename = new URL(req.url).pathname.slice("/_admin-assets/".length);
          return new Response(Bun.file(new URL(filename, adminAssetsDir)));
        },
        ...baseAdminRoutes,
        ...(frontendRoutes as any),
      },

      ...(websocketHandlers ? { websocket: websocketHandlers } : {}),

      async fetch(req, srv) {
        return masterFetch(req, srv);
      },
    });

    // Wire up the mutable server reference for WS pub/sub
    bunServer = server;

    console.log(`BunBase running at ${server.url}`);
    console.log(`Admin UI: ${server.url}_admin`);
    if (config.realtime.enabled) {
      console.log(`Realtime WebSocket: ${String(server.url).replace(/^http/, "ws")}realtime`);
    }
    if (extendWsRoutes.size > 0) {
      const wsBase = String(server.url).replace(/^http/, "ws");
      for (const path of extendWsRoutes.keys()) {
        console.log(`  WebSocket: ${wsBase}${path.slice(1)}`);
      }
    }
    if (options.mailer) {
      console.log("  Email: mailer configured");
    }
    console.log(
      `\n  \x1b[33m[BunBase]\x1b[0m Service key: \x1b[1m${config.serviceKey}\x1b[0m` +
        `\n  \x1b[2mUse as Bearer token for server-to-server admin access. Keep this secret.\x1b[0m\n`,
    );

    // Wrap server.stop() so callers who hold the Bun server reference also stop the scheduler
    if (scheduler) {
      const originalStop = server.stop.bind(server);
      (server as any).stop = (closeActiveConnections?: boolean) => {
        scheduler?.stop();
        return originalStop(closeActiveConnections);
      };
    }

    // Graceful shutdown
    const shutdown = () => {
      console.log("Shutting down...");
      server.stop(); // scheduler.stop() is now called inside the wrapped stop()
      adapter.close();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return server;
  }

  return { db, adapter, config, listen };
}

const DEFAULT_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_ADMIN_PASSWORD = "admin";

async function seedDefaultAdmin(
  db: AnyDb,
  usersTable: any,
  isDevelopment: boolean,
  devExplicit: boolean,
) {
  try {
    const { eq, getTableColumns } = await import("drizzle-orm");
    const columns = getTableColumns(usersTable);
    if (!columns.email || !columns.role) return;

    // Check if any admin exists
    const existing = await (db as any)
      .select({ id: columns.id })
      .from(usersTable)
      .where(eq(columns.role as any, "admin"))
      .limit(1);

    if (existing.length > 0) return;

    // Only seed predictable dev credentials when development mode was explicitly
    // requested (development: true in config, or NODE_ENV=development).
    // When isDevelopment is merely inferred from NODE_ENV being absent, we treat
    // admin seeding as production to avoid predictable credentials in misconfigured
    // production deployments.
    if (isDevelopment && devExplicit) {
      // Development: seed with well-known defaults for convenience
      const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
      const id = Bun.randomUUIDv7();
      await (db as any).insert(usersTable).values({
        id,
        email: DEFAULT_ADMIN_EMAIL,
        passwordHash,
        role: "admin",
      });
      console.log(`\n  \x1b[33m[BunBase]\x1b[0m Default admin created:`);
      console.log(`    Email:    \x1b[1m${DEFAULT_ADMIN_EMAIL}\x1b[0m`);
      console.log(`    Password: \x1b[1m${DEFAULT_ADMIN_PASSWORD}\x1b[0m`);
      console.log(`  \x1b[2mChange this password after your first login.\x1b[0m\n`);
    } else {
      // Production: seed from env vars, or warn if none are configured
      const envEmail = process.env.BUNBASE_ADMIN_EMAIL;
      const envPassword = process.env.BUNBASE_ADMIN_PASSWORD;
      if (envEmail && envPassword) {
        const passwordHash = await hashPassword(envPassword);
        const id = Bun.randomUUIDv7();
        await (db as any).insert(usersTable).values({
          id,
          email: envEmail,
          passwordHash,
          role: "admin",
        });
        console.log(
          `\n  \x1b[33m[BunBase]\x1b[0m Admin account created from environment variables.\n`,
        );
      } else {
        console.warn(
          `\n  \x1b[33m[BunBase]\x1b[0m Warning: No admin account exists and no bootstrap credentials are configured.\n` +
            `  Set BUNBASE_ADMIN_EMAIL and BUNBASE_ADMIN_PASSWORD environment variables to create an admin on startup.\n`,
        );
      }
    }
  } catch {
    // Users table may not have role/email columns — skip seeding silently
  }
}

async function logRequest(
  db: AnyDb,
  internalSchema: InternalSchema,
  req: Request,
  pathname: string,
  start: number,
  response: Response,
  userId: string | null,
) {
  await pushRequestLog(db, internalSchema, {
    id: Bun.randomUUIDv7(),
    method: req.method,
    path: pathname,
    status: response.status,
    durationMs: Date.now() - start,
    userId,
    timestamp: new Date().toISOString(),
  });
}
