import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import type { ResolvedConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import { checkRateLimit, getClientIp } from "../rate-limit.ts";
import {
  consumeRefreshJwt,
  isJwtUserRevoked,
  revokeJwtFamily,
  signJwt,
  verifyJwt,
} from "./core.ts";

/**
 * JWT refresh endpoint.
 * @module
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface JwtRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
}

export function createJwtRoutes(deps: JwtRouteDeps) {
  const { db, internalSchema, config, usersTable } = deps;
  const jwtConfig = config.auth.jwt;

  return {
    "/auth/refresh": {
      async POST(req: Request): Promise<Response> {
        const ip = getClientIp(req, config.trustedProxies);
        const { allowed } = checkRateLimit(ip, config.auth.rateLimit);
        if (!allowed) {
          return jsonError("RATE_LIMITED", "Too many attempts", 429);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z.object({ refreshToken: z.string().max(16384) }).safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "refreshToken is required", 400);
        }

        const secret = jwtConfig.secret!;
        const payload = await verifyJwt(
          result.data.refreshToken,
          secret,
          undefined,
          undefined,
          jwtConfig,
        );

        if (payload?.type !== "refresh") {
          return jsonError("UNAUTHORIZED", "Invalid or expired refresh token", 401);
        }

        if (!(await verifyJwt(result.data.refreshToken, secret, db, internalSchema, jwtConfig))) {
          // A correctly signed replay also invalidates any descendants.
          await revokeJwtFamily(db, internalSchema, payload.fid);
          return jsonError("UNAUTHORIZED", "Invalid or expired refresh token", 401);
        }
        if (!(await consumeRefreshJwt(db, internalSchema, payload))) {
          return jsonError("UNAUTHORIZED", "Refresh token reuse detected", 401);
        }

        const [user] = await (db as any)
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, payload.sub));
        if (!user || typeof user.email !== "string" || typeof user.role !== "string") {
          return jsonError("UNAUTHORIZED", "Invalid or expired refresh token", 401);
        }

        // Issue new access token
        const accessToken = await signJwt(
          {
            iss: payload.iss,
            aud: payload.aud,
            fid: payload.fid,
            sub: payload.sub,
            email: user.email,
            role: user.role,
            type: "access",
            mfaVerified: payload.mfaVerified,
          },
          secret,
          jwtConfig.accessTokenTtl,
        );

        const refreshToken = await signJwt(
          { ...payload, email: user.email, role: user.role, type: "refresh" },
          secret,
          Math.min(jwtConfig.refreshTokenTtl, payload.exp - Date.now() / 1000),
        );

        // A concurrent logout/reset must not be escaped by minting a new token
        // after the first verification but after its revocation cutoff.
        if (
          !(await verifyJwt(accessToken, secret, db, internalSchema, jwtConfig)) ||
          (await isJwtUserRevoked(db, internalSchema, payload))
        ) {
          return jsonError("UNAUTHORIZED", "Invalid or expired refresh token", 401);
        }

        return Response.json({
          accessToken,
          refreshToken,
          expiresIn: jwtConfig.accessTokenTtl,
        });
      },
    },
  };
}
