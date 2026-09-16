import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import { parseCookies } from "./cookies.ts";
import { userHasMfaEnrolled } from "./mfa/index.ts";
import { getSession } from "./sessions.ts";

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

/** Check if a bearer token is a valid service key using constant-time comparison. */
export function isServiceKey(bearerToken: string, serviceKey: string): boolean {
  if (!bearerToken.startsWith("bb_sk_")) return false;
  const a = Buffer.from(bearerToken);
  const b = Buffer.from(serviceKey);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/** Synthetic AuthUser returned for service key authentication. */
export const SERVICE_KEY_USER: AuthUser = {
  id: "__service__",
  email: "",
  role: "admin",
} as AuthUser;

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
    .where(eq(internalSchema.apiKeys.keyHash, keyHash));

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
    .where(eq(usersTable.id, keyRow.userId));

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

/** Paths accessible with a pending-MFA session (mfa_verified === 0). */
const MFA_PENDING_ALLOWED_PREFIXES = ["/auth/mfa/", "/auth/logout"];

function isMfaPendingAllowed(pathname: string): boolean {
  return MFA_PENDING_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Paths accessible when `auth.mfa.required` is on but the user has not yet
 * enrolled MFA. They may reach the MFA enrollment/status endpoints, log out,
 * and read their own identity (so the client can prompt for enrollment) — but
 * nothing else until they enroll.
 */
const MFA_ENROLLMENT_ALLOWED_PREFIXES = ["/auth/mfa/", "/auth/logout", "/auth/me"];

function isMfaEnrollmentAllowed(pathname: string): boolean {
  return MFA_ENROLLMENT_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Subset of config needed by the auth gate. Kept structural to avoid a config import cycle. */
export interface ExtractAuthConfig {
  auth: { mfa: { required: boolean } };
}

/**
 * Resolve authenticated user from service key, session cookie, or bearer API key.
 *
 * Priority: service key > session cookie > JWT > user API key.
 *
 * When a session has `mfa_verified === 0` (password verified but MFA pending),
 * returns `null` for all routes except `/auth/mfa/*` and `/auth/logout`.
 */
export async function extractAuth(
  req: Request,
  db: AnyDb,
  internalSchema: InternalSchema,
  usersTable: any,
  serviceKey?: string,
  config?: ExtractAuthConfig,
): Promise<AuthUser | null> {
  // Extract bearer token once — reused for service key, JWT, and API key checks
  const bearerToken = extractBearerToken(req);

  // Service key — highest priority, bypasses all other auth
  if (bearerToken && serviceKey && isServiceKey(bearerToken, serviceKey)) {
    return SERVICE_KEY_USER;
  }

  // Mandatory-MFA flag. Prefer the explicitly passed config; fall back to a
  // global set at server bootstrap (same pattern as __bunbaseJwtConfig) so the
  // gate works for every extractAuth call site without threading config through
  // each one.
  const mfaRequired =
    config?.auth?.mfa?.required === true ||
    (config === undefined &&
      (globalThis as { __bunbaseMfaRequired?: boolean }).__bunbaseMfaRequired === true);

  const sessionId = extractSessionId(req);

  // Try session cookie first — valid cookie always wins
  if (sessionId) {
    const session = await getSession(db, internalSchema, sessionId);
    if (session) {
      const pathname = new URL(req.url).pathname.replace(/^\/api/, "");

      // MFA enforcement: pending sessions can only access MFA and logout routes.
      // NULL mfa_verified is treated as "not required" (non-MFA users); only an
      // explicit 0 means a step-up is pending.
      if (session.mfa_verified === 0) {
        if (!isMfaPendingAllowed(pathname)) {
          return null;
        }
      }

      // Guest session — return synthetic user without DB lookup
      if (session.is_guest === 1) {
        const _guestUuid = session.user_id.replace(/^guest:/, "");
        return { id: session.user_id, email: "", role: "guest" } as AuthUser;
      }

      const rows = await (db as any)
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, session.user_id));

      const user = rows[0];
      if (user) {
        const { id, email, role } = user;
        if (typeof id === "string" && typeof email === "string" && typeof role === "string") {
          // Mandatory-MFA enforcement: when enabled, a fully-authenticated user
          // who has NOT enrolled MFA is blocked from everything except the MFA
          // enrollment/status endpoints, logout, and /auth/me (so the client can
          // detect the state and prompt enrollment).
          if (mfaRequired && session.mfa_verified !== 0 && !isMfaEnrollmentAllowed(pathname)) {
            const enrolled = await userHasMfaEnrolled(db, internalSchema, id);
            if (!enrolled) {
              return null;
            }
          }
          return { ...user, id, email, role };
        }
      }
    }
  }

  // Fall back to bearer token (no cookie, or cookie was invalid/expired)
  if (bearerToken) {
    let bearerUser: AuthUser | null = null;

    // Check if it's a JWT (has 3 dot-separated parts)
    if (bearerToken.split(".").length === 3) {
      // Try JWT verification
      try {
        const { verifyJwt } = await import("./jwt/core.ts");
        const jwtConfig = (globalThis as any).__bunbaseJwtConfig;
        if (jwtConfig?.enabled && jwtConfig?.secret) {
          const payload = await verifyJwt(bearerToken, jwtConfig.secret, db, internalSchema);
          // Only ACCESS tokens authenticate a request. Refresh tokens share the
          // same secret but must only be redeemable at /auth/refresh; accepting
          // one here would turn a 7-day refresh token into a bearer access token.
          if (payload && payload.type === "access") {
            bearerUser = { id: payload.sub, email: payload.email, role: payload.role } as AuthUser;
          }
        }
      } catch {
        // Not a valid JWT, fall through to API key check
      }
    }

    if (!bearerUser) {
      bearerUser = await getApiKeyUser(db, internalSchema, bearerToken, usersTable);
    }

    // Mandatory-MFA enforcement for bearer credentials too — block unenrolled
    // users from everything except the MFA enrollment/status, logout, and /me.
    if (bearerUser && mfaRequired) {
      const pathname = new URL(req.url).pathname.replace(/^\/api/, "");
      if (!isMfaEnrollmentAllowed(pathname)) {
        const enrolled = await userHasMfaEnrolled(db, internalSchema, bearerUser.id);
        if (!enrolled) {
          return null;
        }
      }
    }

    return bearerUser;
  }

  return null;
}
