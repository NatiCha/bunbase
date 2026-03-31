import type { ResolvedConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import { appendResponseCookies, serializeCookie, sessionCookieOptions } from "../cookies.ts";
import { setCsrfCookie } from "../csrf.ts";
import { createSession } from "../sessions.ts";
import { signJwt } from "./core.ts";

/**
 * Session strategy: returns either cookie-based session or JWT tokens
 * depending on config.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";

export interface AuthResponseOptions {
  user: Record<string, unknown>;
  userId: string;
  email: string;
  role: string;
  status?: number;
  mfaRequired?: boolean;
  mfaMethods?: string[];
  mfaVerified?: boolean;
}

export async function buildAuthResponse(
  config: ResolvedConfig,
  db: AnyDb,
  internalSchema: InternalSchema,
  opts: AuthResponseOptions,
): Promise<Response> {
  const { user, userId, email, role, status = 200, mfaRequired, mfaMethods, mfaVerified } = opts;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;

  // JWT mode
  if (config.auth.jwt.enabled && config.auth.jwt.secret) {
    const secret = config.auth.jwt.secret;

    if (mfaRequired) {
      // For MFA-pending, still create a cookie session (JWT requires full auth)
      const sessionId = await createSession(db, internalSchema, userId, config.auth.tokenExpiry, 0);
      const sessionCookie = serializeCookie(
        SESSION_COOKIE,
        sessionId,
        sessionCookieOptions(isDev, cookieDomain),
      );
      const csrf = setCsrfCookie(isDev, cookieDomain);

      return new Response(
        JSON.stringify({ mfaRequired: true, mfaMethods }),
        appendResponseCookies({ status: 200, headers: { "Content-Type": "application/json" } }, [
          sessionCookie,
          csrf.cookie,
        ]),
      );
    }

    const accessToken = await signJwt(
      { sub: userId, email, role, type: "access", mfaVerified },
      secret,
      config.auth.jwt.accessTokenTtl,
    );

    const refreshToken = await signJwt(
      { sub: userId, email, role, type: "refresh", mfaVerified },
      secret,
      config.auth.jwt.refreshTokenTtl,
    );

    return Response.json(
      {
        accessToken,
        refreshToken,
        expiresIn: config.auth.jwt.accessTokenTtl,
        user,
      },
      { status },
    );
  }

  // Cookie-based session mode (default)
  const mfaVerifiedValue = mfaRequired ? 0 : undefined;
  const sessionId = await createSession(
    db,
    internalSchema,
    userId,
    config.auth.tokenExpiry,
    mfaVerifiedValue,
  );

  const sessionCookie = serializeCookie(
    SESSION_COOKIE,
    sessionId,
    sessionCookieOptions(isDev, cookieDomain),
  );
  const csrf = setCsrfCookie(isDev, cookieDomain);

  const responseBody = mfaRequired ? { mfaRequired: true, mfaMethods } : { user };

  return new Response(
    JSON.stringify(responseBody),
    appendResponseCookies({ status, headers: { "Content-Type": "application/json" } }, [
      sessionCookie,
      csrf.cookie,
    ]),
  );
}
