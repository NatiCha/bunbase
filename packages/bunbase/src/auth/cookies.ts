/**
 * Cookie serialization and auth cookie defaults.
 * @module
 */

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge: number;
  domain?: string;
}

/**
 * Resolve whether auth cookies should carry the `Secure` attribute.
 *
 * Baseline is the legacy `!isDev` rule (deterministic for callers that pass an
 * explicit `development` boolean). On top of that, the running server publishes
 * its resolved `config.secureDefaults` on `globalThis` so the cookie helpers — which receive only an
 * `isDev` boolean from many call sites across the auth modules — can fail closed
 * when `NODE_ENV` is unset (where `isDev` is `true` but secure defaults must
 * still apply).
 *
 * The global can only ever *upgrade* a cookie to `Secure`, never downgrade one:
 * an explicit `setCsrfCookie(false)` (production) stays `Secure` regardless of a
 * dev server having published `false`, which keeps the flag deterministic for
 * unit tests and avoids cross-test global leakage.
 *
 * NOTE: this means local dev MUST run with `NODE_ENV=development` (or
 * `config.development: true`); otherwise `secureDefaults` is `true` and cookies
 * become `Secure`, so the browser will not send them over plain `http://localhost`.
 */
function cookieSecure(isDev: boolean): boolean {
  const secureDefaults = (globalThis as { __bunbaseSecureDefaults?: boolean })
    .__bunbaseSecureDefaults;
  return !isDev || secureDefaults === true;
}

/** Session cookie defaults (`HttpOnly`, 30 days, secure unless secure defaults are off). */
export function sessionCookieOptions(isDev: boolean, domain?: string): CookieOptions {
  return {
    httpOnly: true,
    secure: cookieSecure(isDev),
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 days
    domain,
  };
}

/** CSRF cookie defaults (client-readable, 30 days, secure unless secure defaults are off). */
export function csrfCookieOptions(isDev: boolean, domain?: string): CookieOptions {
  return {
    httpOnly: false, // JS needs to read this
    secure: cookieSecure(isDev),
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    domain,
  };
}

/** Serialize a cookie string from structured options. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  let cookie = `${name}=${value}; Path=${opts.path}; Max-Age=${opts.maxAge}; SameSite=${opts.sameSite}`;
  if (opts.domain) cookie += `; Domain=${opts.domain}`;
  if (opts.httpOnly) cookie += "; HttpOnly";
  if (opts.secure) cookie += "; Secure";
  return cookie;
}

/** Clear an HttpOnly cookie by setting `Max-Age=0`. */
export function clearCookie(name: string, isDev: boolean, domain?: string): string {
  const secure = cookieSecure(isDev) ? "; Secure" : "";
  return `${name}=; Path=/; Max-Age=0; SameSite=lax${domain ? `; Domain=${domain}` : ""}${secure}; HttpOnly`;
}

/** Clear a non-HttpOnly client cookie by setting `Max-Age=0`. */
export function clearClientCookie(name: string, isDev: boolean, domain?: string): string {
  const secure = cookieSecure(isDev) ? "; Secure" : "";
  return `${name}=; Path=/; Max-Age=0; SameSite=lax${domain ? `; Domain=${domain}` : ""}${secure}`;
}

/** Append multiple `Set-Cookie` headers onto a `ResponseInit`. */
export function appendResponseCookies(init: ResponseInit, cookies: string[]): ResponseInit {
  const headers = new Headers(init.headers);
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return {
    ...init,
    headers,
  };
}

/** Parse a Cookie header into a key/value record. */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}
