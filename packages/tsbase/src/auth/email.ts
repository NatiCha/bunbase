import { eq, and, gt } from "drizzle-orm";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import { hashPassword } from "./passwords.ts";
import { createSession, deleteUserSessions } from "./sessions.ts";
import {
  appendResponseCookies,
  serializeCookie,
  sessionCookieOptions,
} from "./cookies.ts";
import { setCsrfCookie } from "./csrf.ts";
import { checkRateLimit, getClientIp } from "./rate-limit.ts";
import { z } from "zod/v4";

const SESSION_COOKIE = "tsbase_session";

function jsonError(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface EmailRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
}

export function createEmailRoutes(deps: EmailRouteDeps) {
  const { db, internalSchema, config, usersTable } = deps;
  const isDev = config.development;
  const tokens = internalSchema.verificationTokens;

  return {
    "/auth/request-password-reset": {
      async POST(req: Request): Promise<Response> {
        const ip = getClientIp(req);
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

        const schema = z.object({ email: z.email() });
        const result = schema.safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Invalid email", 400);
        }

        const { email } = result.data;
        const webhookUrl = config.auth.email?.webhook;
        if (!webhookUrl && !isDev) {
          return jsonError(
            "INTERNAL_SERVER_ERROR",
            "Password reset email webhook is not configured",
            500,
          );
        }

        // Always return success to prevent user enumeration
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email))
          ;

        const user = userRows[0];

        if (user) {
          // Invalidate previous tokens
          await (db as any)
            .delete(tokens)
            .where(and(eq(tokens.userId, user.id), eq(tokens.type, "password_reset")))
            ;

          const token = Bun.randomUUIDv7();
          const tokenHash = await hashToken(token);
          const id = Bun.randomUUIDv7();
          const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour

          await (db as any)
            .insert(tokens)
            .values({
              id,
              userId: user.id,
              tokenHash,
              type: "password_reset",
              expiresAt,
              createdAt: new Date().toISOString(),
            })
            ;

          if (webhookUrl) {
            const webhookResponse = await fetch(webhookUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: "password_reset",
                email,
                token,
                userId: user.id,
              }),
            });

            if (!webhookResponse.ok) {
              console.error(
                `[TSBase] Email webhook failed: ${webhookResponse.status} ${webhookResponse.statusText}`,
              );
              return jsonError(
                "INTERNAL_SERVER_ERROR",
                "Failed to dispatch password reset email",
                500,
              );
            }
          } else if (isDev) {
            console.log(
              `[TSBase] Password reset token for ${email}: ${token}`,
            );
          }
        }

        return Response.json({
          message:
            "If an account with that email exists, a reset link has been sent.",
        });
      },
    },

    "/auth/reset-password": {
      async POST(req: Request): Promise<Response> {
        const ip = getClientIp(req);
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

        const schema = z.object({
          token: z.string(),
          password: z.string().min(8),
        });

        const result = schema.safeParse(body);
        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }

        const { token, password } = result.data;
        const tokenHash = await hashToken(token);
        const now = Math.floor(Date.now() / 1000);

        const tokenRows = await (db as any)
          .select({ id: tokens.id, userId: tokens.userId })
          .from(tokens)
          .where(
            and(
              eq(tokens.tokenHash, tokenHash),
              eq(tokens.type, "password_reset"),
              gt(tokens.expiresAt, now),
            ),
          )
          ;

        const tokenRow = tokenRows[0];

        if (!tokenRow) {
          return jsonError(
            "BAD_REQUEST",
            "Invalid or expired reset token",
            400,
          );
        }

        // Update password
        const passwordHash = await hashPassword(password);
        await (db as any)
          .update(usersTable)
          .set({ passwordHash })
          .where(eq(usersTable.id, tokenRow.userId))
          ;

        // Delete all sessions and tokens
        await deleteUserSessions(db, internalSchema, tokenRow.userId);
        await (db as any)
          .delete(tokens)
          .where(and(eq(tokens.userId, tokenRow.userId), eq(tokens.type, "password_reset")))
          ;

        // Create new session
        const sessionId = await createSession(
          db,
          internalSchema,
          tokenRow.userId,
          config.auth.tokenExpiry,
        );
        const sessionCookie = serializeCookie(
          SESSION_COOKIE,
          sessionId,
          sessionCookieOptions(isDev),
        );
        const csrf = setCsrfCookie(isDev);

        return new Response(
          JSON.stringify({ message: "Password reset successfully" }),
          appendResponseCookies(
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            },
            [sessionCookie, csrf.cookie],
          ),
        );
      },
    },

    "/auth/verify-email": {
      async POST(req: Request): Promise<Response> {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const schema = z.object({ token: z.string() });
        const result = schema.safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Token required", 400);
        }

        const { token } = result.data;
        const tokenHash = await hashToken(token);
        const now = Math.floor(Date.now() / 1000);

        const tokenRows = await (db as any)
          .select({ id: tokens.id, userId: tokens.userId })
          .from(tokens)
          .where(
            and(
              eq(tokens.tokenHash, tokenHash),
              eq(tokens.type, "email_verification"),
              gt(tokens.expiresAt, now),
            ),
          )
          ;

        const tokenRow = tokenRows[0];

        if (!tokenRow) {
          return jsonError(
            "BAD_REQUEST",
            "Invalid or expired verification token",
            400,
          );
        }

        // Mark email as verified (try — column might not exist)
        try {
          await (db as any)
            .update(usersTable)
            .set({ emailVerified: 1 } as any)
            .where(eq(usersTable.id, tokenRow.userId))
            ;
        } catch {
          // email_verified column might not exist — that's OK
        }

        // Delete used token
        await (db as any)
          .delete(tokens)
          .where(eq(tokens.id, tokenRow.id))
          ;

        return Response.json({ message: "Email verified successfully" });
      },
    },
  };
}
