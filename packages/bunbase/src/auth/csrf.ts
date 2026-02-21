import { parseCookies, serializeCookie, csrfCookieOptions } from "./cookies.ts";

/**
 * CSRF helpers using a double-submit cookie strategy.
 * @module
 */

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
  return cookieToken === headerToken;
}

/**
 * Create and serialize a new CSRF cookie token.
 */
export function setCsrfCookie(isDev: boolean): {
  token: string;
  cookie: string;
} {
  const token = generateCsrfToken();
  const cookie = serializeCookie(CSRF_COOKIE, token, csrfCookieOptions(isDev));
  return { token, cookie };
}

// Routes exempt from CSRF (no existing session to hijack)
const CSRF_EXEMPT_PATHS = new Set([
  "/auth/register",
  "/auth/login",
  "/auth/request-password-reset",
  "/auth/reset-password",
  "/auth/verify-email",
]);

export function isCsrfExempt(pathname: string): boolean {
  return (
    CSRF_EXEMPT_PATHS.has(pathname) || pathname.startsWith("/auth/oauth/")
  );
}
