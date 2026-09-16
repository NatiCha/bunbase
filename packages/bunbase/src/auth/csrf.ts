import { timingSafeEqual } from "node:crypto";
import { csrfCookieOptions, parseCookies, serializeCookie } from "./cookies.ts";

/**
 * CSRF helpers using a double-submit cookie strategy.
 * @module
 */

/** Constant-time string comparison; returns false for unequal-length inputs. */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch — guard first. Returning early on
  // a length difference is safe: the token is a fixed-length UUID, so a length
  // mismatch already means the value is wrong.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}

const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";

/** Generate a random CSRF token. */
export function generateCsrfToken(): string {
  return Bun.randomUUIDv7();
}

/**
 * Validate CSRF by comparing cookie token to `x-csrf-token` header.
 */
export function validateCsrf(req: Request): boolean {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers.get(CSRF_HEADER);

  if (!cookieToken || !headerToken) return false;
  return constantTimeEqual(cookieToken, headerToken);
}

/**
 * Create and serialize a new CSRF cookie token.
 */
export function setCsrfCookie(
  isDev: boolean,
  domain?: string,
): {
  token: string;
  cookie: string;
} {
  const token = generateCsrfToken();
  const cookie = serializeCookie(CSRF_COOKIE, token, csrfCookieOptions(isDev, domain));
  return { token, cookie };
}

// Routes exempt from CSRF (no existing session to hijack)
const CSRF_EXEMPT_PATHS = new Set([
  "/auth/register",
  "/auth/login",
  "/auth/request-password-reset",
  "/auth/reset-password",
  "/auth/verify-email",
  // Passwordless auth (stateless, like login)
  "/auth/magic-link/request",
  "/auth/magic-link/verify",
  "/auth/otp/request",
  "/auth/otp/verify",
  // MFA verification (session is pending, not yet fully authenticated)
  "/auth/mfa/totp/verify",
  "/auth/mfa/backup/verify",
  // Passkey auth (stateless, like login)
  "/auth/passkeys/login/options",
  "/auth/passkeys/login/verify",
  // SMS OTP (stateless, like login)
  "/auth/sms-otp/request",
  "/auth/sms-otp/verify",
  // Guest auth (no existing session)
  "/auth/guest",
  "/auth/guest/convert",
  // Invite validation (public)
  "/auth/invites/validate",
  // Org invite acceptance
  "/auth/organization-invites/accept",
  // JWT refresh (stateless)
  "/auth/refresh",
]);

export function isCsrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PATHS.has(pathname) || pathname.startsWith("/auth/oauth/");
}
