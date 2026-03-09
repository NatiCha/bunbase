import { and, eq, gt } from "drizzle-orm";
import { z } from "zod/v4";
import { ApiError } from "../api/helpers.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import type { Mailer } from "../mailer/index.ts";
import { deleteUserApiKeys } from "./api-keys.ts";
import { appendResponseCookies, serializeCookie, sessionCookieOptions } from "./cookies.ts";
import { setCsrfCookie } from "./csrf.ts";
import { hashPassword } from "./passwords.ts";
import { checkRateLimit, getClientIp } from "./rate-limit.ts";
import { createSession, deleteUserSessions } from "./sessions.ts";
import { hashToken } from "./tokens.ts";

/**
 * Password reset and email verification auth routes.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface EmailRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  authHooks?: AuthHooks;
  mailer?: Mailer;
}

/**
 * Create password reset and email verification routes.
 *
 * @remarks Password reset tokens expire after 3600 seconds (1 hour).
 * Email verification tokens expire after 86400 seconds (24 hours).
 * When a mailer is provided, emails are sent directly. Otherwise the webhook
 * is used as a fallback, and in development a token is printed to the console.
 */
export function createEmailRoutes(deps: EmailRouteDeps) {
  const { db, internalSchema, config, usersTable, authHooks, mailer } = deps;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;
  const tokens = internalSchema.verificationTokens;

  /** Verify an email token — shared between GET (browser click) and POST (API call). */
  async function verifyEmailToken(token: string): Promise<{ ok: boolean; message: string }> {
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
      );

    const tokenRow = tokenRows[0];
    if (!tokenRow) {
      return { ok: false, message: "Invalid or expired verification token" };
    }

    // Mark email as verified (try — column might not exist)
    try {
      await (db as any)
        .update(usersTable)
        .set({ emailVerified: 1 } as any)
        .where(eq(usersTable.id, tokenRow.userId));
    } catch {
      // email_verified column might not exist — that's OK
    }

    // Delete used token
    await (db as any).delete(tokens).where(eq(tokens.id, tokenRow.id));

    if (authHooks?.afterEmailVerify) {
      try {
        await authHooks.afterEmailVerify({ userId: tokenRow.userId });
      } catch (err) {
        console.error("[BunBase] afterEmailVerify hook error:", err);
      }
    }

    return { ok: true, message: "Email verified successfully" };
  }

  /** Minimal self-contained HTML page shown after clicking a verification link. */
  function verifyResultHtml(success: boolean, message: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${success ? "Email Verified" : "Verification Failed"}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#111}
.card{max-width:400px;padding:32px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);text-align:center}
h1{font-size:20px;margin-bottom:8px}
p{font-size:14px;color:#6b7280;margin-bottom:20px}
a{color:#3b82f6;text-decoration:none;font-size:14px}a:hover{text-decoration:underline}
.icon{font-size:48px;margin-bottom:12px}</style></head>
<body><div class="card">
<div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
<h1>${success ? "Email Verified" : "Verification Failed"}</h1>
<p>${message}</p>
<a href="/">Continue to app &rarr;</a>
</div></body></html>`;
  }

  return {
    "/auth/request-password-reset": {
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

        const schema = z.object({ email: z.email() });
        const result = schema.safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Invalid email", 400);
        }

        const { email } = result.data;
        const webhookUrl = config.auth.email?.webhook;

        // In production with no mailer and no webhook, log a warning but still return 200
        // to prevent user enumeration — we just won't actually send the email.
        if (!mailer && !webhookUrl && !isDev) {
          console.warn(
            "[BunBase] Warning: password reset requested but no mailer or email webhook is configured.",
          );
        }

        // Always return success to prevent user enumeration
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));

        const user = userRows[0];

        if (user) {
          // Invalidate previous tokens
          await (db as any)
            .delete(tokens)
            .where(and(eq(tokens.userId, user.id), eq(tokens.type, "password_reset")));

          const token = Bun.randomUUIDv7();
          const tokenHash = await hashToken(token);
          const id = Bun.randomUUIDv7();
          const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour

          await (db as any).insert(tokens).values({
            id,
            userId: user.id,
            tokenHash,
            type: "password_reset",
            expiresAt,
            createdAt: new Date().toISOString(),
          });

          if (mailer) {
            // Mailer takes precedence over webhook
            try {
              await mailer.sendPasswordReset({ token, email, userId: String(user.id) });
            } catch (err) {
              console.error("[BunBase] Mailer failed to send password reset email:", err);
              // Fall through — do not expose failure (anti-enumeration)
            }
          } else if (webhookUrl) {
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
                `[BunBase] Email webhook failed: ${webhookResponse.status} ${webhookResponse.statusText}`,
              );
              // Fall through to return success — do not expose whether the
              // email exists (webhook failures must not be an enumeration oracle)
            }
          } else if (isDev) {
            console.log(`[BunBase] Password reset token for ${email}: ${token}`);
          }
        }

        return Response.json({
          message: "If an account with that email exists, a reset link has been sent.",
        });
      },
    },

    "/auth/reset-password": {
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
          );

        const tokenRow = tokenRows[0];

        if (!tokenRow) {
          return jsonError("BAD_REQUEST", "Invalid or expired reset token", 400);
        }

        if (authHooks?.beforePasswordReset) {
          try {
            await authHooks.beforePasswordReset({ userId: tokenRow.userId });
          } catch (err) {
            if (err instanceof ApiError) {
              return jsonError(err.code, err.message, err.status);
            }
            return jsonError(
              "AUTH_HOOK_ERROR",
              "An error occurred in beforePasswordReset hook",
              500,
            );
          }
        }

        // Update password
        const passwordHash = await hashPassword(password);
        await (db as any)
          .update(usersTable)
          .set({ passwordHash })
          .where(eq(usersTable.id, tokenRow.userId));

        // Delete all sessions, API keys, and tokens
        await deleteUserSessions(db, internalSchema, tokenRow.userId);
        await deleteUserApiKeys(db, internalSchema, tokenRow.userId);
        await (db as any)
          .delete(tokens)
          .where(and(eq(tokens.userId, tokenRow.userId), eq(tokens.type, "password_reset")));

        if (authHooks?.afterPasswordReset) {
          try {
            await authHooks.afterPasswordReset({ userId: tokenRow.userId });
          } catch (err) {
            console.error("[BunBase] afterPasswordReset hook error:", err);
          }
        }

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
          sessionCookieOptions(isDev, cookieDomain),
        );
        const csrf = setCsrfCookie(isDev, cookieDomain);

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
      // GET — browser clicks the link in the email
      async GET(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        if (!token) {
          return new Response(verifyResultHtml(false, "Missing verification token"), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        const result = await verifyEmailToken(token);
        return new Response(verifyResultHtml(result.ok, result.message), {
          status: result.ok ? 200 : 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },

      // POST — programmatic API call from client SDK
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

        const verified = await verifyEmailToken(result.data.token);
        if (!verified.ok) {
          return jsonError("BAD_REQUEST", verified.message, 400);
        }
        return Response.json({ message: verified.message });
      },
    },

    "/auth/request-email-verification": {
      async POST(req: Request): Promise<Response> {
        const ip = getClientIp(req, config.trustedProxies);
        const { allowed } = checkRateLimit(ip);
        if (!allowed) {
          return jsonError("RATE_LIMITED", "Too many attempts", 429);
        }

        if (!mailer) {
          return jsonError(
            "NOT_CONFIGURED",
            "Email verification requires a mailer to be configured",
            503,
          );
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

        // Always return 200 to prevent enumeration
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));

        const user = userRows[0];

        if (user) {
          // Invalidate previous email_verification tokens
          await (db as any)
            .delete(tokens)
            .where(and(eq(tokens.userId, user.id), eq(tokens.type, "email_verification")));

          const token = Bun.randomUUIDv7();
          const tokenHash = await hashToken(token);
          const id = Bun.randomUUIDv7();
          const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours

          await (db as any).insert(tokens).values({
            id,
            userId: user.id,
            tokenHash,
            type: "email_verification",
            expiresAt,
            createdAt: new Date().toISOString(),
          });

          try {
            await mailer.sendEmailVerification({ token, email, userId: String(user.id) });
          } catch (err) {
            console.error("[BunBase] Mailer failed to send email verification:", err);
            // Fall through — anti-enumeration
          }
        }

        return Response.json({
          message: "If an account with that email exists, a verification link has been sent.",
        });
      },
    },
  };
}
