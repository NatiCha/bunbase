import { z } from "zod/v4";
import type { ResolvedConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import { checkRateLimit, getClientIp } from "../rate-limit.ts";
import { signJwt, verifyJwt } from "./core.ts";

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
  const { db, internalSchema, config } = deps;
  const jwtConfig = config.auth.jwt;

  return {
    "/auth/refresh": {
      async POST(req: Request): Promise<Response> {
        const ip = getClientIp(req, config.trustedProxies);
        const { allowed } = checkRateLimit(ip);
        if (!allowed) {
          return jsonError("RATE_LIMITED", "Too many attempts", 429);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z.object({ refreshToken: z.string() }).safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "refreshToken is required", 400);
        }

        const secret = jwtConfig.secret!;
        const payload = await verifyJwt(result.data.refreshToken, secret, db, internalSchema);

        if (!payload || payload.type !== "refresh") {
          return jsonError("UNAUTHORIZED", "Invalid or expired refresh token", 401);
        }

        // Issue new access token
        const accessToken = await signJwt(
          {
            sub: payload.sub,
            email: payload.email,
            role: payload.role,
            type: "access",
            mfaVerified: payload.mfaVerified,
          },
          secret,
          jwtConfig.accessTokenTtl,
        );

        return Response.json({
          accessToken,
          expiresIn: jwtConfig.accessTokenTtl,
        });
      },
    },
  };
}
