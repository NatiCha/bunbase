import { eq, and, or, isNull, lt } from "drizzle-orm";
import { parseCookies } from "./cookies.ts";
import { getSession } from "./sessions.ts";
import type { AuthUser } from "../api/types.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";

/**
 * Request authentication extractors and bearer/session precedence.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";

/** Extract session id from BunBase session cookie. */
export function extractSessionId(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookies = parseCookies(cookieHeader);
  return cookies[SESSION_COOKIE] ?? null;
}

/** Extract bearer token from Authorization header. */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/**
 * Returns true when the request carries a Bearer token but NO session cookie.
 * Used to safely bypass CSRF — prevents attackers from adding a dummy
 * Authorization header while the real session cookie is present.
 */
export function isBearerOnly(req: Request): boolean {
  return extractBearerToken(req) !== null && extractSessionId(req) === null;
}

export async function getApiKeyUser(
  db: AnyDb,
  internalSchema: InternalSchema,
  apiKey: string,
  usersTable: any,
): Promise<AuthUser | null> {
  if (!usersTable) return null;

  // Hash the key with SHA-256
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(apiKey);
  const keyHash = hasher.digest("hex");

  // Look up by hash
  const rows = await (db as any)
    .select()
    .from(internalSchema.apiKeys)
    .where(eq(internalSchema.apiKeys.keyHash, keyHash))
    ;

  const keyRow = rows[0];
  if (!keyRow) return null;

  // Check expiry (epoch seconds)
  if (keyRow.expiresAt != null) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (keyRow.expiresAt < nowSec) return null;
  }

  // Look up the owning user
  const userRows = await (db as any)
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, keyRow.userId))
    ;

  const user = userRows[0];
  if (!user) return null;

  const { id, email, role } = user;
  if (typeof id !== "string" || typeof email !== "string" || typeof role !== "string") {
    return null;
  }

  // Throttled last_used_at update — fire-and-forget to avoid write amplification.
  // Only writes when last_used_at is NULL or older than 5 minutes ago.
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  (db as any)
    .update(internalSchema.apiKeys)
    .set({ lastUsedAt: nowIso })
    .where(
      and(
        eq(internalSchema.apiKeys.id, keyRow.id),
        or(
          isNull(internalSchema.apiKeys.lastUsedAt),
          lt(internalSchema.apiKeys.lastUsedAt, fiveMinutesAgo),
        ),
      ),
    )
    .then(() => {})
    .catch(() => {});

  return { ...user, id, email, role };
}

/**
 * Resolve authenticated user from session cookie first, then bearer API key.
 */
export async function extractAuth(
  req: Request,
  db: AnyDb,
  internalSchema: InternalSchema,
  usersTable: any,
): Promise<AuthUser | null> {
  const sessionId = extractSessionId(req);

  // Try session cookie first — valid cookie always wins
  if (sessionId) {
    const session = await getSession(db, internalSchema, sessionId);
    if (session) {
      const rows = await (db as any)
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, session.user_id))
        ;

      const user = rows[0];
      if (user) {
        const { id, email, role } = user;
        if (typeof id === "string" && typeof email === "string" && typeof role === "string") {
          return { ...user, id, email, role };
        }
      }
    }
  }

  // Fall back to bearer token (no cookie, or cookie was invalid/expired)
  const apiKey = extractBearerToken(req);
  if (apiKey) {
    return getApiKeyUser(db, internalSchema, apiKey, usersTable);
  }

  return null;
}
