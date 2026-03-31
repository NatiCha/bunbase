import { and, eq, gt } from "drizzle-orm";
import { z } from "zod/v4";
import type { AuthUser } from "../api/types.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import type { Mailer } from "../mailer/index.ts";
import { appendResponseCookies, serializeCookie, sessionCookieOptions } from "./cookies.ts";
import { setCsrfCookie } from "./csrf.ts";
import { checkRateLimit, getClientIp } from "./rate-limit.ts";
import { createSession } from "./sessions.ts";
import { hashToken } from "./tokens.ts";

/**
 * Magic link and email OTP passwordless auth routes.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** Strip passwordHash from user object before returning. */
function stripSensitive(user: Record<string, unknown>): Record<string, unknown> {
  const { passwordHash, password_hash, ...rest } = user;
  return rest;
}

interface PasswordlessRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  authHooks?: AuthHooks;
  mailer?: Mailer;
}

/**
 * Generate a numeric OTP code of the given length.
 */
function generateOtpCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => (b % 10).toString())
    .join("");
}

/**
 * Shared logic: find or create a user by email, create a session, return cookies + user.
 */
async function authenticateByEmail(
  deps: PasswordlessRouteDeps,
  email: string,
  isNewUserAllowed: boolean,
): Promise<{
  user: Record<string, unknown>;
  userId: string;
  isNewUser: boolean;
  sessionCookie: string;
  csrfCookie: string;
} | null> {
  const { db, internalSchema, config, usersTable } = deps;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;

  const userRows = await (db as any)
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  let user = userRows[0];
  let isNewUser = false;

  if (!user) {
    if (!isNewUserAllowed) return null;

    // Auto-create user
    const id = Bun.randomUUIDv7();
    const createdAt = new Date().toISOString();
    await (db as any).insert(usersTable).values({
      id,
      email,
      passwordHash: "", // No password for passwordless users
      role: "user",
      emailVerified: 1, // Email is implicitly verified
      createdAt,
    });

    const newRows = await (db as any)
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, id));
    user = newRows[0];
    isNewUser = true;
  }

  if (!user) return null;

  const sessionId = await createSession(
    db,
    internalSchema,
    user.id,
    config.auth.tokenExpiry,
    1, // mfaVerified = 1, passwordless is full auth
  );

  const sessionCookie = serializeCookie(
    SESSION_COOKIE,
    sessionId,
    sessionCookieOptions(isDev, cookieDomain),
  );
  const csrf = setCsrfCookie(isDev, cookieDomain);

  return {
    user,
    userId: user.id,
    isNewUser,
    sessionCookie,
    csrfCookie: csrf.cookie,
  };
}

export function createPasswordlessRoutes(deps: PasswordlessRouteDeps) {
  const { db, internalSchema, config, usersTable, authHooks, mailer } = deps;
  const isDev = config.development;
  const tokens = internalSchema.verificationTokens;
  const magicLinkConfig = config.auth.mfa.magicLink;
  const otpConfig = config.auth.mfa.otp;

  const routes: Record<string, Record<string, (req: Request) => Response | Promise<Response>>> = {};

  // ─── Magic Link Routes ───

  if (magicLinkConfig.enabled) {
    routes["/auth/magic-link/request"] = {
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

        if (authHooks?.beforeMagicLinkLogin) {
          try {
            await authHooks.beforeMagicLinkLogin({ email, req });
          } catch (err: any) {
            if (err?.code && err?.status) {
              return jsonError(err.code, err.message, err.status);
            }
            return jsonError("AUTH_HOOK_ERROR", "An error occurred in beforeMagicLinkLogin hook", 500);
          }
        }

        // Always return success to prevent user enumeration
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));

        const user = userRows[0];

        if (user) {
          // Invalidate previous magic link tokens
          await (db as any)
            .delete(tokens)
            .where(and(eq(tokens.userId, user.id), eq(tokens.type, "magic_link")));

          const token = Bun.randomUUIDv7();
          const tokenHash = await hashToken(token);
          const id = Bun.randomUUIDv7();
          const expiresAt = Math.floor(Date.now() / 1000) + magicLinkConfig.ttl;

          await (db as any).insert(tokens).values({
            id,
            userId: user.id,
            tokenHash,
            type: "magic_link",
            expiresAt,
            createdAt: new Date().toISOString(),
          });

          if (mailer) {
            try {
              // Derive base URL from the request origin
              const origin = new URL(req.url).origin;
              const verifyUrl = `${origin}/api/auth/magic-link/verify?token=${token}`;
              await mailer.send({
                to: email,
                subject: "Sign in to your account",
                html: `<p>Click the link below to sign in:</p><p><a href="${verifyUrl}">Sign in</a></p><p>This link expires in ${Math.floor(magicLinkConfig.ttl / 60)} minutes.</p>`,
              });
            } catch (err) {
              console.error("[BunBase] Mailer failed to send magic link:", err);
            }
          } else if (isDev) {
            console.log(`[BunBase] Magic link token for ${email}: ${token}`);
          }
        }

        return Response.json({
          message: "If an account with that email exists, a sign-in link has been sent.",
        });
      },
    };

    routes["/auth/magic-link/verify"] = {
      // GET — browser clicks the link in the email
      async GET(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        if (!token) {
          return new Response(magicLinkResultHtml(false, "Missing verification token"), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        const result = await verifyMagicLink(token);
        if (!result) {
          return new Response(magicLinkResultHtml(false, "Invalid or expired magic link"), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        const html = magicLinkResultHtml(true, "Successfully signed in");
        return new Response(html, appendResponseCookies(
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
          [result.sessionCookie, result.csrfCookie],
        ));
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

        const authResult = await verifyMagicLink(result.data.token);
        if (!authResult) {
          return jsonError("BAD_REQUEST", "Invalid or expired magic link", 400);
        }

        return new Response(
          JSON.stringify({ user: stripSensitive(authResult.user) }),
          appendResponseCookies(
            { status: 200, headers: { "Content-Type": "application/json" } },
            [authResult.sessionCookie, authResult.csrfCookie],
          ),
        );
      },
    };
  }

  // ─── Email OTP Routes ───

  if (otpConfig.enabled) {
    routes["/auth/otp/request"] = {
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

        if (authHooks?.beforeOtpLogin) {
          try {
            await authHooks.beforeOtpLogin({ email, req });
          } catch (err: any) {
            if (err?.code && err?.status) {
              return jsonError(err.code, err.message, err.status);
            }
            return jsonError("AUTH_HOOK_ERROR", "An error occurred in beforeOtpLogin hook", 500);
          }
        }

        // Always return success to prevent user enumeration
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));

        const user = userRows[0];

        if (user) {
          // Invalidate previous OTP tokens
          await (db as any)
            .delete(tokens)
            .where(and(eq(tokens.userId, user.id), eq(tokens.type, "email_otp")));

          const code = generateOtpCode(otpConfig.length);
          const codeHash = await hashToken(code);
          const id = Bun.randomUUIDv7();
          const expiresAt = Math.floor(Date.now() / 1000) + otpConfig.ttl;

          await (db as any).insert(tokens).values({
            id,
            userId: user.id,
            tokenHash: codeHash,
            type: "email_otp",
            expiresAt,
            createdAt: new Date().toISOString(),
          });

          if (mailer) {
            try {
              await mailer.send({
                to: email,
                subject: "Your sign-in code",
                html: `<p>Your one-time code is: <strong>${code}</strong></p><p>This code expires in ${Math.floor(otpConfig.ttl / 60)} minutes.</p>`,
              });
            } catch (err) {
              console.error("[BunBase] Mailer failed to send OTP:", err);
            }
          } else if (isDev) {
            console.log(`[BunBase] OTP code for ${email}: ${code}`);
          }
        }

        return Response.json({
          message: "If an account with that email exists, a code has been sent.",
        });
      },
    };

    routes["/auth/otp/verify"] = {
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

        const schema = z.object({ email: z.email(), code: z.string() });
        const result = schema.safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Email and code required", 400);
        }

        const { email, code } = result.data;
        const codeHash = await hashToken(code);
        const now = Math.floor(Date.now() / 1000);

        // Find user first
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));

        const user = userRows[0];
        if (!user) {
          return jsonError("UNAUTHORIZED", "Invalid email or code", 401);
        }

        // Verify the OTP token
        const tokenRows = await (db as any)
          .select({ id: tokens.id, userId: tokens.userId })
          .from(tokens)
          .where(
            and(
              eq(tokens.userId, user.id),
              eq(tokens.tokenHash, codeHash),
              eq(tokens.type, "email_otp"),
              gt(tokens.expiresAt, now),
            ),
          );

        const tokenRow = tokenRows[0];
        if (!tokenRow) {
          return jsonError("UNAUTHORIZED", "Invalid or expired code", 401);
        }

        // Delete used token
        await (db as any).delete(tokens).where(eq(tokens.id, tokenRow.id));

        // Authenticate
        const authResult = await authenticateByEmail(deps, email, false);
        if (!authResult) {
          return jsonError("UNAUTHORIZED", "Authentication failed", 401);
        }

        if (authHooks?.afterOtpLogin) {
          try {
            await authHooks.afterOtpLogin({ user: stripSensitive(authResult.user), userId: authResult.userId });
          } catch (err) {
            console.error("[BunBase] afterOtpLogin hook error:", err);
          }
        }

        return new Response(
          JSON.stringify({ user: stripSensitive(authResult.user) }),
          appendResponseCookies(
            { status: 200, headers: { "Content-Type": "application/json" } },
            [authResult.sessionCookie, authResult.csrfCookie],
          ),
        );
      },
    };
  }

  // ─── Helpers ───

  async function verifyMagicLink(token: string) {
    const tokenHash = await hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const tokenRows = await (db as any)
      .select({ id: tokens.id, userId: tokens.userId })
      .from(tokens)
      .where(
        and(
          eq(tokens.tokenHash, tokenHash),
          eq(tokens.type, "magic_link"),
          gt(tokens.expiresAt, now),
        ),
      );

    const tokenRow = tokenRows[0];
    if (!tokenRow) return null;

    // Delete used token
    await (db as any).delete(tokens).where(eq(tokens.id, tokenRow.id));

    // Load user
    const userRows = await (db as any)
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, tokenRow.userId));

    const user = userRows[0];
    if (!user) return null;

    const isDev = config.development;
    const cookieDomain = config.cookieDomain;

    const sessionId = await createSession(
      db,
      internalSchema,
      user.id,
      config.auth.tokenExpiry,
      1, // mfaVerified = 1
    );

    const sessionCookie = serializeCookie(
      SESSION_COOKIE,
      sessionId,
      sessionCookieOptions(isDev, cookieDomain),
    );
    const csrf = setCsrfCookie(isDev, cookieDomain);

    if (authHooks?.afterMagicLinkLogin) {
      try {
        await authHooks.afterMagicLinkLogin({
          user: stripSensitive(user),
          userId: user.id,
          isNewUser: false,
        });
      } catch (err) {
        console.error("[BunBase] afterMagicLinkLogin hook error:", err);
      }
    }

    return { user, sessionCookie, csrfCookie: csrf.cookie };
  }

  function magicLinkResultHtml(success: boolean, message: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${success ? "Signed In" : "Sign-In Failed"}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#111}
.card{max-width:400px;padding:32px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);text-align:center}
h1{font-size:20px;margin-bottom:8px}
p{font-size:14px;color:#6b7280;margin-bottom:20px}
a{color:#3b82f6;text-decoration:none;font-size:14px}a:hover{text-decoration:underline}
.icon{font-size:48px;margin-bottom:12px}</style></head>
<body><div class="card">
<div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
<h1>${success ? "Signed In" : "Sign-In Failed"}</h1>
<p>${message}</p>
<a href="/">Continue to app &rarr;</a>
</div></body></html>`;
  }

  return routes;
}
