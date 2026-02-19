import { eq } from "drizzle-orm";
import { parseCookies } from "./cookies.ts";
import { getSession } from "./sessions.ts";
import type { AuthUser } from "../trpc/context.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";

const SESSION_COOKIE = "tsbase_session";

export function extractSessionId(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookies = parseCookies(cookieHeader);
  return cookies[SESSION_COOKIE] ?? null;
}

export async function extractAuth(
  req: Request,
  db: AnyDb,
  internalSchema: InternalSchema,
  usersTable: any,
): Promise<AuthUser | null> {
  const sessionId = extractSessionId(req);
  if (!sessionId) return null;

  const session = await getSession(db, internalSchema, sessionId);
  if (!session) return null;

  // Look up the user via Drizzle
  const rows = await (db as any)
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.user_id))
    ;

  const user = rows[0];
  if (!user) return null;

  const id = user.id;
  const email = user.email;
  const role = user.role;
  if (typeof id !== "string" || typeof email !== "string" || typeof role !== "string") {
    return null;
  }

  return {
    ...user,
    id,
    email,
    role,
  };
}
