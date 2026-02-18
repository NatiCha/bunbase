import type { TSBaseConfig } from "./config.ts";
import { resolveConfig, type ResolvedConfig } from "./config.ts";
import { createDatabase, runUserMigrations } from "./database.ts";
import {
  bootstrapInternalTables,
  injectTimestampColumns,
  validateUsersTable,
  getUserTableNames,
} from "./bootstrap.ts";
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
import type { AnyTRPCRouter } from "@trpc/server";
import type { Database } from "bun:sqlite";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
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
  db: SQLiteBunDatabase;
  sqlite: Database;
  config: ResolvedConfig;
  listen: (port?: number) => ReturnType<typeof Bun.serve>;
}

export function createServer(options: CreateServerOptions): TSBaseServer {
  const tableRules =
    options.rules as Record<string, TableRules> | undefined;
  const config = resolveConfig(options.config);
  const { db, sqlite } = createDatabase(config);

  // Bootstrap internal tables
  bootstrapInternalTables(sqlite);

  // Migrate user-defined tables from Drizzle migrations
  runUserMigrations(db, config);

  // Validate users table if provided
  const usersTable = validateUsersTable(options.schema);

  // Get user-defined table names and inject timestamps
  const tableNames = getUserTableNames(options.schema);
  if (tableNames.length > 0) {
    injectTimestampColumns(sqlite, tableNames);
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
    return extractAuthFromReq(req, sqlite);
  };

  // Create tRPC context factory
  const createContext = createContextFactory({ db, extractAuth });

  // Build auth route handlers
  const authRoutes = createAuthRoutes({
    sqlite,
    config,
    usersTable: usersTable as any,
  });
  const emailRoutes = createEmailRoutes({ sqlite, config });
  const oauthRoutes = createOAuthRoutes({ sqlite, config });
  const fileRoutes = createFileRoutes({
    sqlite,
    db,
    config,
    schema: options.schema,
    rules: tableRules,
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
            sqlite,
            config,
            options.schema,
            adminStorage,
          );
          const durationMs = Date.now() - start;
          const user = await extractAuthFromReq(req, sqlite).catch(() => null);
          pushRequestLog(sqlite, {
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
          return adminUI;
        }

        // Exact match HTTP routes
        const routeHandlers = httpRoutes[pathname];
        if (routeHandlers) {
          const handler = routeHandlers[req.method];
          if (handler) {
            const response = await handler(req);
            logRequest(sqlite, req, pathname, start, response, null);
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
              logRequest(sqlite, req, pathname, start, response, null);
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
              const realUser = await extractAuthFromReq(trpcReq, sqlite);

              // Admin impersonation — only honoured when caller is a verified admin
              const impersonateId = trpcReq.headers.get("x-impersonate-user");
              if (impersonateId && realUser?.role === "admin") {
                const targetUser = sqlite
                  .query<Record<string, unknown>, { $id: string }>(
                    "SELECT * FROM users WHERE id = $id",
                  )
                  .get({ $id: impersonateId }) as AuthUser | null;
                if (targetUser) {
                  return { db, user: targetUser };
                }
              }

              return createContext({ req: trpcReq });
            },
          });
          logRequest(sqlite, req, pathname, start, response, null);
          return addCorsHeaders(response, req, config);
        }

        const notFound = new Response("Not Found", { status: 404 });
        logRequest(sqlite, req, pathname, start, notFound, null);
        return addCorsHeaders(notFound, req, config);
      },
    });

    console.log(`TSBase running at ${server.url}`);
    console.log(`Admin UI: ${server.url}_admin`);

    // Graceful shutdown
    const shutdown = () => {
      console.log("Shutting down...");
      server.stop();
      sqlite.close();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    return server;
  }

  return { appRouter, db, sqlite, config, listen };
}

function logRequest(
  sqlite: Database,
  req: Request,
  pathname: string,
  start: number,
  response: Response,
  userId: string | null,
) {
  pushRequestLog(sqlite, {
    id: Bun.randomUUIDv7(),
    method: req.method,
    path: pathname,
    status: response.status,
    durationMs: Date.now() - start,
    userId,
    timestamp: new Date().toISOString(),
  });
}
