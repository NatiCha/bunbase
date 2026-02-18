import type { Database } from "bun:sqlite";
import { parseCookies } from "./cookies.ts";
import { getSession } from "./sessions.ts";
import type { AuthUser } from "../trpc/context.ts";

const SESSION_COOKIE = "tsbase_session";

export function extractSessionId(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookies = parseCookies(cookieHeader);
  return cookies[SESSION_COOKIE] ?? null;
}

export async function extractAuth(
  req: Request,
  sqlite: Database,
): Promise<AuthUser | null> {
  const sessionId = extractSessionId(req);
  if (!sessionId) return null;

  const session = getSession(sqlite, sessionId);
  if (!session) return null;

  // Look up the user
  const user = sqlite
    .query<Record<string, unknown>, { $id: string }>(
      "SELECT * FROM users WHERE id = $id",
    )
    .get({ $id: session.user_id });

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
