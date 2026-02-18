import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  [key: string]: unknown;
}

export interface Context {
  db: SQLiteBunDatabase;
  auth: AuthUser | null;
  req: Request;
}

export interface CreateContextDeps {
  db: SQLiteBunDatabase;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
}

export function createContextFactory(deps: CreateContextDeps) {
  return async (opts: { req: Request }): Promise<Context> => {
    const auth = await deps.extractAuth(opts.req);
    return {
      db: deps.db,
      auth,
      req: opts.req,
    };
  };
}
