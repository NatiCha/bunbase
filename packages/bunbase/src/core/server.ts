import pkg from "../../package.json";
import type { BunBaseConfig } from "./config.ts";
import { resolveConfig, type ResolvedConfig } from "./config.ts";
import { createDatabase, runUserMigrations } from "./database.ts";
import { validateUsersTable } from "./bootstrap.ts";
import { getInternalSchema } from "./internal-schema.ts";
import type { InternalSchema } from "./internal-schema.ts";
import type { AnyDb } from "./db-types.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { addCorsHeaders, handleCorsPreflightOrNull } from "../cors.ts";
import { createAuthRoutes } from "../auth/routes.ts";
import { createEmailRoutes } from "../auth/email.ts";
import { createOAuthRoutes } from "../auth/oauth/routes.ts";
import { extractAuth as extractAuthFromReq } from "../auth/middleware.ts";
import { validateCsrf, isCsrfExempt } from "../auth/csrf.ts";
import { generateAllCrudHandlers } from "../crud/handler.ts";
import { createFileRoutes, createStorageDriver } from "../storage/routes.ts";
import { handleAdminApi, pushRequestLog } from "../admin/routes.ts";
import { hashPassword } from "../auth/passwords.ts";
import type { AuthUser } from "../api/types.ts";
import type { TableRules } from "../rules/types.ts";
import type { TableHooks } from "../hooks/types.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import type { JobDefinition } from "../jobs/types.ts";
import { JobScheduler } from "../jobs/scheduler.ts";
import { RealtimeManager } from "../realtime/manager.ts";
import { PresenceTracker } from "../realtime/presence.ts";
import { handleWebSocketMessage, handleWebSocketClose } from "../realtime/handler.ts";
import adminUI from "../../admin-ui/index.html";

export type RouteMap = Record<
  string,
  Record<string, (req: Request) => Response | Promise<Response>>
>;

export interface ExtendContext {
  db: AnyDb;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
}

export interface CreateServerOptions {
  schema: Record<string, unknown>;
  relations?: unknown;
  rules?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  authHooks?: AuthHooks;
  jobs?: JobDefinition[];
  config?: BunBaseConfig;
  extend?: (ctx: ExtendContext) => RouteMap;
}

export interface BunBaseServer {
  db: AnyDb;
  adapter: DatabaseAdapter;
  config: ResolvedConfig;
  listen: (port?: number) => ReturnType<typeof Bun.serve>;
}

export function createServer(options: CreateServerOptions): BunBaseServer {
  const tableRules =
    options.rules as Record<string, TableRules> | undefined;
  const tableHooks =
    options.hooks as Record<string, TableHooks> | undefined;
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
        options.config?.development === true ||
        process.env.NODE_ENV === "development";
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
    const realUser = await extractAuthFromReq(req, db, internalSchema, usersTable);

    // Admin impersonation — only honoured when caller is a verified admin
    const impersonateId = req.headers.get("x-impersonate-user");
    if (impersonateId && realUser?.role === "admin") {
      const targetUser = await adapter.rawQueryOne<Record<string, unknown>>(
        "SELECT * FROM users WHERE id = $id",
        { $id: impersonateId },
      );
      if (targetUser) {
        return targetUser as AuthUser;
      }
    }

    return realUser;
  };

  // Realtime manager + broadcast shim (only when realtime is enabled)
  let realtimeManager: RealtimeManager | undefined;
  let realtimePresence: PresenceTracker | undefined;
  let broadcastFn: ((t: string, a: "INSERT" | "UPDATE" | "DELETE", r: Record<string, unknown>) => void) | undefined;

  if (config.realtime.enabled) {
    realtimeManager = new RealtimeManager(db, options.schema, tableRules);
    realtimePresence = new PresenceTracker();
    broadcastFn = (t, a, r) => {
      realtimeManager!.broadcastTableChange(t, a, r).catch((err) => {
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

  // Build auth route handlers
  const authRoutes = createAuthRoutes({
    db,
    internalSchema,
    config,
    usersTable: usersTable as any,
    authHooks,
  });
  const emailRoutes = createEmailRoutes({
    db,
    internalSchema,
    config,
    usersTable,
    authHooks,
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

  // Storage driver for admin operations
  const adminStorage = createStorageDriver(config);

  // Merge all HTTP routes into a lookup map
  const httpRoutes: RouteMap = {};

  for (const routeSet of [authRoutes, emailRoutes, oauthRoutes, fileRoutes, crudExact]) {
    for (const [path, handlers] of Object.entries(routeSet)) {
      httpRoutes[path] = handlers as Record<
        string,
        (req: Request) => Response | Promise<Response>
      >;
    }
  }

  // Merge extend routes (if provided)
  if (options.extend) {
    const extendRoutes = options.extend({ db, extractAuth });
    for (const [path, handlers] of Object.entries(extendRoutes)) {
      if (!path.startsWith("/api/")) {
        throw new Error(
          `BunBase: extend routes must be under /api/. Got: "${path}". This ensures CSRF protection is applied automatically.`,
        );
      }
      if (httpRoutes[path]) {
        throw new Error(
          `BunBase: Cannot merge extend routes due to path collision: ${path}`,
        );
      }
      if (crudPattern[path]) {
        throw new Error(
          `BunBase: Cannot merge extend routes due to path collision with CRUD item route: ${path}`,
        );
      }
      httpRoutes[path] = handlers;
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
      const regex = new RegExp(
        "^" + path.replace(/:[a-zA-Z]+/g, "([^/]+)") + "$",
      );
      patternRoutes.push({
        pattern: regex,
        handlers: handlers as Record<
          string,
          (req: Request) => Response | Promise<Response>
        >,
      });
      delete httpRoutes[path];
    }
  }

  // Add CRUD item routes (/api/{table}/:id) to patternRoutes
  for (const [path, handlers] of Object.entries(crudPattern)) {
    const regex = new RegExp(
      "^" + path.replace(/:[a-zA-Z]+/g, "([^/]+)") + "$",
    );
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
          scheduler!.start(options.jobs!);
        } catch (err) {
          console.error("[BunBase] Failed to start job scheduler:", err);
        }
      })();
    }

    // Mutable server reference needed by WS handlers for server.publish()
    let bunServer: ReturnType<typeof Bun.serve>;

    const websocketHandlers = realtimeManager && realtimePresence
      ? {
          async message(ws: any, raw: string | Buffer) {
            await handleWebSocketMessage(ws, raw, bunServer, realtimeManager!, realtimePresence!);
          },
          close(ws: any) {
            handleWebSocketClose(ws, bunServer, realtimeManager!, realtimePresence!);
          },
          open(_ws: any) {
            // Connection established — nothing to do here
          },
        }
      : undefined;

    const server = Bun.serve({
      port: resolvedPort,

      routes: {
        "/health": Response.json({ status: "ok", version: pkg.version }),
        "/_admin": adminUI,
        "/_admin/": adminUI,
      },

      ...(websocketHandlers ? { websocket: websocketHandlers } : {}),

      async fetch(req, srv) {
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
          const auth = await extractAuthFromReq(req, db, internalSchema, usersTable).catch(() => null);
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

        // Inject socket IP header for all HTTP routes. Must happen after the WebSocket
        // path above since cloning req would invalidate the native handle needed by srv.upgrade().
        // We always overwrite any client-provided value to prevent spoofing.
        const enrichedHeaders = new Headers(req.headers);
        enrichedHeaders.set("x-bunbase-socket-ip", socketIp);
        req = new Request(req, { headers: enrichedHeaders });

        // CSRF check for state-changing mutations — covers both /api/ and /_admin/api/
        if (
          (pathname.startsWith("/api/") || pathname.startsWith("/_admin/api/")) &&
          ["POST", "PATCH", "DELETE"].includes(req.method) &&
          !isCsrfExempt(pathname)
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
          const user = await extractAuthFromReq(req, db, internalSchema, usersTable).catch(() => null);
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

        // SPA catch-all for /_admin/*
        if (pathname.startsWith("/_admin")) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/_admin" },
          });
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
          return addCorsHeaders(
            new Response("Method Not Allowed", { status: 405 }),
            req,
            config,
          );
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
            return addCorsHeaders(
              new Response("Method Not Allowed", { status: 405 }),
              req,
              config,
            );
          }
        }

        const notFound = new Response("Not Found", { status: 404 });
        await logRequest(db, internalSchema, req, pathname, start, notFound, null);
        return addCorsHeaders(notFound, req, config);
      },
    });

    // Wire up the mutable server reference for WS pub/sub
    bunServer = server;

    console.log(`BunBase running at ${server.url}`);
    console.log(`Admin UI: ${server.url}_admin`);
    if (config.realtime.enabled) {
      console.log(`Realtime WebSocket: ${String(server.url).replace(/^http/, "ws")}realtime`);
    }

    // Wrap server.stop() so callers who hold the Bun server reference also stop the scheduler
    if (scheduler) {
      const originalStop = server.stop.bind(server);
      (server as any).stop = (closeActiveConnections?: boolean) => {
        scheduler!.stop();
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
    if (!columns["email"] || !columns["role"]) return;

    // Check if any admin exists
    const existing = await (db as any)
      .select({ id: columns["id"] })
      .from(usersTable)
      .where(eq(columns["role"] as any, "admin"))
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
        console.log(`\n  \x1b[33m[BunBase]\x1b[0m Admin account created from environment variables.\n`);
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
