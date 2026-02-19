import type { TSBaseConfig } from "./config.ts";
import { resolveConfig, type ResolvedConfig } from "./config.ts";
import { createDatabase, runUserMigrations } from "./database.ts";
import { validateUsersTable, getUserTableNames } from "./bootstrap.ts";
import { getInternalSchema } from "./internal-schema.ts";
import type { InternalSchema } from "./internal-schema.ts";
import type { AnyDb } from "./db-types.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { createAppRouter } from "../trpc/router.ts";
import { createContextFactory, type AuthUser } from "../trpc/context.ts";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { addCorsHeaders, handleCorsPreflightOrNull } from "../cors.ts";
import { createAuthRoutes } from "../auth/routes.ts";
import { createEmailRoutes } from "../auth/email.ts";
import { createOAuthRoutes } from "../auth/oauth/routes.ts";
import { extractAuth as extractAuthFromReq } from "../auth/middleware.ts";
import { validateCsrf, isCsrfExempt } from "../auth/csrf.ts";
import { generateAllCrudRouters } from "../crud/generator.ts";
import { createFileRoutes, createStorageDriver } from "../storage/routes.ts";
import { handleAdminApi, pushRequestLog } from "../admin/routes.ts";
import { hashPassword } from "../auth/passwords.ts";
import type { AnyTRPCRouter } from "@trpc/server";
import type { TableRules } from "../rules/types.ts";
import adminUI from "../../admin-ui/index.html";

export interface CreateServerOptions {
  schema: Record<string, unknown>;
  rules?: Record<string, unknown>;
  config?: TSBaseConfig;
  extend?: AnyTRPCRouter;
}

export interface TSBaseServer {
  appRouter: ReturnType<typeof createAppRouter>;
  db: AnyDb;
  adapter: DatabaseAdapter;
  config: ResolvedConfig;
  listen: (port?: number) => ReturnType<typeof Bun.serve>;
}

export function createServer(options: CreateServerOptions): TSBaseServer {
  const tableRules =
    options.rules as Record<string, TableRules> | undefined;
  const config = resolveConfig(options.config);
  const { db, dialect, adapter } = createDatabase(config);
  const internalSchema = getInternalSchema(dialect);

  // Bootstrap internal tables (DDL via adapter)
  // This is synchronous in the constructor path — we use a sync wrapper
  // that works because SQLite is sync and Postgres bootstrap is awaited at listen() time
  let bootstrapped = false;
  const bootstrapPromise = (async () => {
    await adapter.bootstrapInternalTables();

    // Migrate user-defined tables from Drizzle migrations
    await runUserMigrations(db, config);

    // Create user tables if they don't exist (dev convenience)
    await adapter.createUserTables(options.schema);

    // Validate users table if provided
    const usersTable = validateUsersTable(options.schema);

    // Get user-defined table names and inject timestamps
    const tableNames = getUserTableNames(options.schema);
    if (tableNames.length > 0) {
      await adapter.injectTimestampColumns(tableNames);
    }

    // Seed default admin if users table exists and no admin user exists
    if (usersTable) {
      await seedDefaultAdmin(db, usersTable);
    }

    bootstrapped = true;
    return usersTable;
  })();

  // For SQLite (sync), the promise resolves immediately in the microtask queue
  // For Postgres, listen() will await it
  let usersTable: any = null;

  // Validate users table synchronously for SQLite compat
  try {
    usersTable = validateUsersTable(options.schema);
  } catch {
    // Will be caught again during bootstrap
  }

  // Generate CRUD routers from schema with rules
  const crudRouters = generateAllCrudRouters(
    options.schema,
    db,
    tableRules,
  );

  // Create app router
  const appRouter = createAppRouter(crudRouters, options.extend);

  // Auth extractor
  const extractAuth = async (req: Request): Promise<AuthUser | null> => {
    return extractAuthFromReq(req, db, internalSchema, usersTable);
  };

  // Create tRPC context factory
  const createContext = createContextFactory({ db, extractAuth });

  // Build auth route handlers
  const authRoutes = createAuthRoutes({
    db,
    internalSchema,
    config,
    usersTable: usersTable as any,
  });
  const emailRoutes = createEmailRoutes({
    db,
    internalSchema,
    config,
    usersTable,
  });
  const oauthRoutes = createOAuthRoutes({
    db,
    internalSchema,
    config,
    usersTable,
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
  const httpRoutes: Record<
    string,
    Record<string, (req: Request) => Response | Promise<Response>>
  > = {};
  for (const routeSet of [authRoutes, emailRoutes, oauthRoutes, fileRoutes]) {
    for (const [path, handlers] of Object.entries(routeSet)) {
      httpRoutes[path] = handlers as Record<
        string,
        (req: Request) => Response | Promise<Response>
      >;
    }
  }

  // Pattern-based routes (with path params)
  const patternRoutes: Array<{
    pattern: RegExp;
    handlers: Record<string, (req: Request) => Response | Promise<Response>>;
  }> = [];

  // Convert pattern routes from file routes
  for (const [path, handlers] of Object.entries(httpRoutes)) {
    if (path.includes(":")) {
      // Convert Express-style params to regex
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

  function listen(port?: number) {
    const envPort = Number(process.env.PORT);
    const resolvedPort =
      port !== undefined ? port : Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;

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

        // Admin API — must be before tRPC
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

        // SPA catch-all for /_admin/* (hash routing handles client-side nav)
        if (pathname.startsWith("/_admin")) {
          // Redirect to /_admin which is handled by Bun's static routes
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

        // Pattern match HTTP routes (file routes with params)
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

        // CSRF check for tRPC mutations
        if (
          pathname.startsWith("/trpc") &&
          req.method === "POST" &&
          !isCsrfExempt(pathname)
        ) {
          if (!validateCsrf(req)) {
            return addCorsHeaders(
              Response.json(
                {
                  error: {
                    code: "FORBIDDEN",
                    message: "Invalid CSRF token",
                  },
                },
                { status: 403 },
              ),
              req,
              config,
            );
          }
        }

        // tRPC handler
        if (pathname.startsWith("/trpc")) {
          const response = await fetchRequestHandler({
            req,
            router: appRouter,
            endpoint: "/trpc",
            createContext: async ({ req: trpcReq }) => {
              const realUser = await extractAuthFromReq(trpcReq, db, internalSchema, usersTable);

              // Admin impersonation — only honoured when caller is a verified admin
              const impersonateId = trpcReq.headers.get("x-impersonate-user");
              if (impersonateId && realUser?.role === "admin") {
                // Look up target user via adapter (dynamic query)
                const targetUser = await adapter.rawQueryOne<Record<string, unknown>>(
                  "SELECT * FROM users WHERE id = $id",
                  { $id: impersonateId },
                );
                if (targetUser) {
                  return { db, user: targetUser as AuthUser };
                }
              }

              return createContext({ req: trpcReq });
            },
          });
          await logRequest(db, internalSchema, req, pathname, start, response, null);
          return addCorsHeaders(response, req, config);
        }

        const notFound = new Response("Not Found", { status: 404 });
        await logRequest(db, internalSchema, req, pathname, start, notFound, null);
        return addCorsHeaders(notFound, req, config);
      },
    });

    console.log(`TSBase running at ${server.url}`);
    console.log(`Admin UI: ${server.url}_admin`);

    // Graceful shutdown
    const shutdown = () => {
      console.log("Shutting down...");
      server.stop();
      adapter.close();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return server;
  }

  return { appRouter, db, adapter, config, listen };
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
