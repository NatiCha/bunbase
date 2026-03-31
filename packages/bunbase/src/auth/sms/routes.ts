import { and, eq, gt } from "drizzle-orm";
import { z } from "zod/v4";
import type { ResolvedConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import type { AuthHooks } from "../../hooks/auth-types.ts";
import {
  appendResponseCookies,
  serializeCookie,
  sessionCookieOptions,
} from "../cookies.ts";
import { setCsrfCookie } from "../csrf.ts";
import { checkRateLimit, getClientIp } from "../rate-limit.ts";
import { createSession } from "../sessions.ts";
import { hashToken } from "../tokens.ts";
import type { SmsTransport } from "./types.ts";

/**
 * SMS OTP auth routes.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function generateOtp(length: number): string {
  const digits = "0123456789";
  let code = "";
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  for (let i = 0; i < length; i++) {
    code += digits[randomBytes[i]! % 10];
  }
  return code;
}

interface SmsOtpDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  smsTransport?: SmsTransport;
  authHooks?: AuthHooks;
}

export function createSmsOtpRoutes(deps: SmsOtpDeps) {
  const { db, internalSchema, config, usersTable, smsTransport, authHooks } = deps;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;
  const tokens = internalSchema.verificationTokens;
  const otpConfig = config.auth.mfa.smsOtp;

  return {
    "/auth/sms-otp/request": {
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

        const result = z.object({ phone: z.string().min(1) }).safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Phone number is required", 400);
        }

        const { phone } = result.data;

        if (authHooks?.beforeSmsOtpLogin) {
          try {
            await authHooks.beforeSmsOtpLogin({ phone, req });
          } catch (err: any) {
            if (err?.code && err?.status) {
              return jsonError(err.code, err.message, err.status);
            }
            return jsonError("AUTH_HOOK_ERROR", "An error occurred in beforeSmsOtpLogin hook", 500);
          }
        }

        // Look up user by phone column
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.phone, phone));

        const user = userRows[0];

        // Always return success to prevent enumeration
        if (user) {
          // Invalidate previous sms_otp tokens
          await (db as any)
            .delete(tokens)
            .where(and(eq(tokens.userId, user.id), eq(tokens.type, "sms_otp")));

          const code = generateOtp(otpConfig.length);
          const tokenHash = await hashToken(code);
          const id = Bun.randomUUIDv7();
          const expiresAt = Math.floor(Date.now() / 1000) + otpConfig.ttl;

          await (db as any).insert(tokens).values({
            id,
            userId: user.id,
            tokenHash,
            type: "sms_otp",
            expiresAt,
            createdAt: new Date().toISOString(),
          });

          if (smsTransport) {
            try {
              await smsTransport.send({
                to: phone,
                body: `Your verification code is: ${code}`,
              });
            } catch (err) {
              console.error("[BunBase] SMS transport failed:", err);
            }
          } else if (isDev) {
            console.log(`[BunBase] SMS OTP for ${phone}: ${code}`);
          }
        }

        return Response.json({ message: "If an account with that phone exists, a code has been sent." });
      },
    },

    "/auth/sms-otp/verify": {
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

        const result = z
          .object({
            phone: z.string().min(1),
            code: z.string().min(1),
          })
          .safeParse(body);

        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Phone and code are required", 400);
        }

        const { phone, code } = result.data;

        // Look up user by phone
        const userRows = await (db as any)
          .select()
          .from(usersTable)
          .where(eq(usersTable.phone, phone));

        const user = userRows[0];
        if (!user) {
          return jsonError("UNAUTHORIZED", "Invalid phone or code", 401);
        }

        const tokenHash = await hashToken(code);
        const now = Math.floor(Date.now() / 1000);

        const tokenRows = await (db as any)
          .select({ id: tokens.id, userId: tokens.userId })
          .from(tokens)
          .where(
            and(
              eq(tokens.userId, String(user.id)),
              eq(tokens.tokenHash, tokenHash),
              eq(tokens.type, "sms_otp"),
              gt(tokens.expiresAt, now),
            ),
          );

        if (tokenRows.length === 0) {
          return jsonError("UNAUTHORIZED", "Invalid phone or code", 401);
        }

        // Delete used token
        await (db as any).delete(tokens).where(eq(tokens.id, tokenRows[0].id));

        // Create session
        const sessionId = await createSession(db, internalSchema, String(user.id), config.auth.tokenExpiry);

        if (authHooks?.afterSmsOtpLogin) {
          try {
            await authHooks.afterSmsOtpLogin({
              user: { ...user },
              userId: String(user.id),
            });
          } catch (err) {
            console.error("[BunBase] afterSmsOtpLogin hook error:", err);
          }
        }

        const sanitized = { ...user };
        delete sanitized.password_hash;
        delete sanitized.passwordHash;

        const sessionCookie = serializeCookie(
          SESSION_COOKIE,
          sessionId,
          sessionCookieOptions(isDev, cookieDomain),
        );
        const csrf = setCsrfCookie(isDev, cookieDomain);

        return new Response(
          JSON.stringify({ user: sanitized }),
          appendResponseCookies(
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
            [sessionCookie, csrf.cookie],
          ),
        );
      },
    },
  };
}
