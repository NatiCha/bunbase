export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge: number;
}

export function sessionCookieOptions(isDev: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: !isDev,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  };
}

export function csrfCookieOptions(isDev: boolean): CookieOptions {
  return {
    httpOnly: false, // JS needs to read this
    secure: !isDev,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  };
}

export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions,
): string {
  let cookie = `${name}=${value}; Path=${opts.path}; Max-Age=${opts.maxAge}; SameSite=${opts.sameSite}`;
  if (opts.httpOnly) cookie += "; HttpOnly";
  if (opts.secure) cookie += "; Secure";
  return cookie;
}

export function clearCookie(name: string, isDev: boolean): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=lax${isDev ? "" : "; Secure"}; HttpOnly`;
}

export function clearClientCookie(name: string, isDev: boolean): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=lax${isDev ? "" : "; Secure"}`;
}

export function appendResponseCookies(
  init: ResponseInit,
  cookies: string[],
): ResponseInit {
  const headers = new Headers(init.headers);
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return {
    ...init,
    headers,
  };
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}
