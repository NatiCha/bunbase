import type { TSBaseConfig } from "./config.ts";
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
  rules?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  authHooks?: AuthHooks;
  jobs?: JobDefinition[];
  config?: TSBaseConfig;
  extend?: (ctx: ExtendContext) => RouteMap;
}

export interface TSBaseServer {
  db: AnyDb;
  adapter: DatabaseAdapter;
  config: ResolvedConfig;
  listen: (port?: number) => ReturnType<typeof Bun.serve>;
}

export function createServer(options: CreateServerOptions): TSBaseServer {
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
        throw new Error(`[TSBase] Duplicate job name: "${job.name}"`);
      }
      seen.add(job.name);
    }
  }

  const config = resolveConfig(options.config);
  const { db, dialect, adapter } = createDatabase(config);
  const internalSchema = getInternalSchema(dialect);

  // Bootstrap internal tables (DDL via adapter)
  let bootstrapped = false;
  const bootstrapPromise = (async () => {
    await adapter.bootstrapInternalTables();

    // Migrate user-defined tables from Drizzle migrations
    await runUserMigrations(db, config);

    // Validate users table if provided
    const usersTable = validateUsersTable(options.schema);

    // Seed default admin if users table exists and no admin user exists
    if (usersTable) {
      await seedDefaultAdmin(db, usersTable);
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

  // Generate CRUD REST handlers from schema with rules and hooks
  const { exact: crudExact, pattern: crudPattern } = generateAllCrudHandlers(
    options.schema,
    db,
    extractAuth,
    tableRules,
    tableHooks,
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
          `TSBase: extend routes must be under /api/. Got: "${path}". This ensures CSRF protection is applied automatically.`,
        );
      }
      if (httpRoutes[path]) {
        throw new Error(
          `TSBase: Cannot merge extend routes due to path collision: ${path}`,
        );
      }
      if (crudPattern[path]) {
        throw new Error(
          `TSBase: Cannot merge extend routes due to path collision with CRUD item route: ${path}`,
        );
      }
      httpRoutes[path] = handlers;
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
          console.error("[TSBase] Failed to start job scheduler:", err);
        }
      })();
    }

    const server = Bun.serve({
      port: resolvedPort,

      routes: {
        "/health": new Response("OK"),
        "/_admin": adminUI,
        "/_admin/": adminUI,
      },

      async fetch(req) {
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

        // CSRF check for API mutations
        if (
          pathname.startsWith("/api/") &&
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

    console.log(`TSBase running at ${server.url}`);
    console.log(`Admin UI: ${server.url}_admin`);

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

async function seedDefaultAdmin(db: AnyDb, usersTable: any) {
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

    const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
    const id = Bun.randomUUIDv7();

    await (db as any).insert(usersTable).values({
      id,
      email: DEFAULT_ADMIN_EMAIL,
      passwordHash,
      role: "admin",
    });

    console.log(`\n  \x1b[33m[TSBase]\x1b[0m Default admin created:`);
    console.log(`    Email:    \x1b[1m${DEFAULT_ADMIN_EMAIL}\x1b[0m`);
    console.log(`    Password: \x1b[1m${DEFAULT_ADMIN_PASSWORD}\x1b[0m`);
    console.log(`  \x1b[2mChange this password after your first login.\x1b[0m\n`);
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
