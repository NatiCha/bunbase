import type { AnyDb } from "../core/db-types.ts";

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  [key: string]: unknown;
}

export interface Context {
  db: AnyDb;
  auth: AuthUser | null;
  req: Request;
}

export interface CreateContextDeps {
  db: AnyDb;
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
