import type { Database } from "bun:sqlite";
import type { ResolvedConfig } from "../core/config.ts";
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
  sqlite: Database;
  config: ResolvedConfig;
}

export function createEmailRoutes(deps: EmailRouteDeps) {
  const { sqlite, config } = deps;
  const isDev = config.development;

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
        const user = sqlite
          .query<{ id: string }, { $email: string }>(
            "SELECT id FROM users WHERE email = $email",
          )
          .get({ $email: email });

        if (user) {
          // Invalidate previous tokens
          sqlite
            .query(
              "DELETE FROM _verification_tokens WHERE user_id = $userId AND type = $type",
            )
            .run({
              $userId: user.id,
              $type: "password_reset",
            });

          const token = Bun.randomUUIDv7();
          const tokenHash = await hashToken(token);
          const id = Bun.randomUUIDv7();
          const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour

          sqlite
            .query(
              `INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at)
               VALUES ($id, $userId, $tokenHash, $type, $expiresAt, $createdAt)`,
            )
            .run({
              $id: id,
              $userId: user.id,
              $tokenHash: tokenHash,
              $type: "password_reset",
              $expiresAt: expiresAt,
              $createdAt: new Date().toISOString(),
            });

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

        const tokenRow = sqlite
          .query<
            { id: string; user_id: string },
            { $tokenHash: string; $type: string; $now: number }
          >(
            `SELECT id, user_id FROM _verification_tokens
             WHERE token_hash = $tokenHash AND type = $type AND expires_at > $now`,
          )
          .get({
            $tokenHash: tokenHash,
            $type: "password_reset",
            $now: now,
          });

        if (!tokenRow) {
          return jsonError(
            "BAD_REQUEST",
            "Invalid or expired reset token",
            400,
          );
        }

        // Update password
        const passwordHash = await hashPassword(password);
        sqlite
          .query("UPDATE users SET password_hash = $hash WHERE id = $id")
          .run({ $hash: passwordHash, $id: tokenRow.user_id });

        // Delete all sessions and tokens
        deleteUserSessions(sqlite, tokenRow.user_id);
        sqlite
          .query(
            "DELETE FROM _verification_tokens WHERE user_id = $userId AND type = $type",
          )
          .run({
            $userId: tokenRow.user_id,
            $type: "password_reset",
          });

        // Create new session
        const sessionId = createSession(
          sqlite,
          tokenRow.user_id,
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

        const tokenRow = sqlite
          .query<
            { id: string; user_id: string },
            { $tokenHash: string; $type: string; $now: number }
          >(
            `SELECT id, user_id FROM _verification_tokens
             WHERE token_hash = $tokenHash AND type = $type AND expires_at > $now`,
          )
          .get({
            $tokenHash: tokenHash,
            $type: "email_verification",
            $now: now,
          });

        if (!tokenRow) {
          return jsonError(
            "BAD_REQUEST",
            "Invalid or expired verification token",
            400,
          );
        }

        // Mark email as verified
        try {
          sqlite
            .query(
              "UPDATE users SET email_verified = 1 WHERE id = $id",
            )
            .run({ $id: tokenRow.user_id });
        } catch {
          // email_verified column might not exist — that's OK
        }

        // Delete used token
        sqlite
          .query("DELETE FROM _verification_tokens WHERE id = $id")
          .run({ $id: tokenRow.id });

        return Response.json({ message: "Email verified successfully" });
      },
    },
  };
}
