import type { Column } from "drizzle-orm";
import { eq, getColumns, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { ApiError } from "../api/helpers.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import type { Mailer } from "../mailer/index.ts";
import {
  appendResponseCookies,
  clearClientCookie,
  clearCookie,
  serializeCookie,
  sessionCookieOptions,
} from "./cookies.ts";
import { setCsrfCookie, validateCsrf } from "./csrf.ts";
import { extractAuth, extractSessionId, isBearerOnly } from "./middleware.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { checkRateLimit, getClientIp } from "./rate-limit.ts";
import { createSession, deleteSession } from "./sessions.ts";
import { hashToken } from "./tokens.ts";

/**
 * Primary auth routes: register, login, logout, and me.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";
const BLOCKED_SIGNUP_FIELDS = new Set([
  "id",
  "role",
  "passwordHash",
  "password_hash",
  "created_at",
  "updated_at",
]);

type UsersRow = Record<string, unknown>;
type UsersColumnInfo = {
  key: string;
  column: Column;
};

interface AuthRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any | null;
  authHooks?: AuthHooks;
  mailer?: Mailer;
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function withRateLimit(
  req: Request,
  trustedProxies: string[],
  handler: () => Promise<Response>,
): Promise<Response> {
  const ip = getClientIp(req, trustedProxies);
  const { allowed, retryAfterMs } = checkRateLimit(ip);

  if (!allowed) {
    return Promise.resolve(
      jsonError(
        "RATE_LIMITED",
        `Too many attempts. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
        429,
      ),
    );
  }

  return handler();
}

function stripSensitiveUserFields(user: UsersRow): UsersRow {
  const sanitized = { ...user };
  delete sanitized.password_hash;
  delete sanitized.passwordHash;
  return sanitized;
}

function getUsersColumns(usersTable: any | null): {
  byInputField: Map<string, UsersColumnInfo>;
  requiredSignupColumns: Set<string>;
} {
  const byInputField = new Map<string, UsersColumnInfo>();
  const requiredSignupColumns = new Set<string>();

  if (!usersTable) {
    return { byInputField, requiredSignupColumns };
  }

  const columns = getColumns(usersTable);
  for (const [key, column] of Object.entries(columns)) {
    const col = column as Column;
    byInputField.set(key, { key, column: col });
    byInputField.set((col as any).name, { key, column: col });

    if (
      (col as any).notNull &&
      !(col as any).hasDefault &&
      !BLOCKED_SIGNUP_FIELDS.has(key) &&
      !BLOCKED_SIGNUP_FIELDS.has((col as any).name) &&
      key !== "email"
    ) {
      requiredSignupColumns.add(key);
    }
  }

  return { byInputField, requiredSignupColumns };
}

function resolvePasswordHash(user: UsersRow): string | null {
  const hash = user.password_hash ?? user.passwordHash;
  if (typeof hash === "string" && hash.length > 0) {
    return hash;
  }
  return null;
}

/**
 * Build BunBase core auth routes.
 *
 * @remarks
 * - `register` and `login` are rate-limited.
 * - `logout` requires CSRF unless request is bearer-only.
 * - Signup blocks privileged/internal fields by default.
 */
export function createAuthRoutes(deps: AuthRouteDeps) {
  const { db, internalSchema, config, usersTable, authHooks, mailer } = deps;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;
  const { byInputField, requiredSignupColumns } = getUsersColumns(usersTable);

  return {
    "/auth/register": {
      async POST(req: Request): Promise<Response> {
        return withRateLimit(req, config.trustedProxies, async () => {
          if (!usersTable) {
            return jsonError("INTERNAL_SERVER_ERROR", "BunBase users table is not configured", 500);
          }

          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
          }

          const bodyResult = z.record(z.string(), z.unknown()).safeParse(body);
          if (!bodyResult.success) {
            return jsonError("VALIDATION_ERROR", "Invalid input", 400);
          }

          const raw = bodyResult.data;
          const baseSchema = z.object({
            email: z.email(),
            password: z.string().min(8),
          });

          const result = baseSchema.safeParse(raw);
          if (!result.success) {
            return jsonError(
              "VALIDATION_ERROR",
              result.error.issues[0]?.message ?? "Invalid input",
              400,
            );
          }

          const { email, password } = result.data;

          const extraFields = Object.entries(raw).filter(
            ([key]) => key !== "email" && key !== "password",
          );

          const signupExtrasByKey: Record<string, unknown> = {};
          const providedExtraColumns = new Set<string>();
          for (const [field, value] of extraFields) {
            if (BLOCKED_SIGNUP_FIELDS.has(field)) {
              return jsonError("BAD_REQUEST", `Field "${field}" cannot be set during signup`, 400);
            }

            const columnInfo = byInputField.get(field);
            if (!columnInfo) {
              return jsonError("BAD_REQUEST", `Unknown users field "${field}"`, 400);
            }

            if (
              BLOCKED_SIGNUP_FIELDS.has(columnInfo.key) ||
              BLOCKED_SIGNUP_FIELDS.has((columnInfo.column as any).name)
            ) {
              return jsonError("BAD_REQUEST", `Field "${field}" cannot be set during signup`, 400);
            }

            signupExtrasByKey[columnInfo.key] = value;
            providedExtraColumns.add(columnInfo.key);
          }

          const missingRequired = [...requiredSignupColumns].filter(
            (key) => !providedExtraColumns.has(key),
          );
          if (missingRequired.length > 0) {
            return jsonError(
              "BAD_REQUEST",
              `Missing required signup fields: ${missingRequired.join(", ")}`,
              400,
            );
          }

          // Check existing user via Drizzle
          const existingRows = await (db as any)
            .select({ id: usersTable.id })
            .from(usersTable)
            .where(sql`lower(${usersTable.email}) = lower(${email})`);

          if (existingRows.length > 0) {
            return jsonError("CONFLICT", "Email already registered", 409);
          }

          const id = Bun.randomUUIDv7();
          const passwordHash = await hashPassword(password);

          let insertData: Record<string, unknown> = {
            id,
            email,
            passwordHash: passwordHash,
            role: "user",
            ...signupExtrasByKey,
          };

          if (authHooks?.beforeRegister) {
            try {
              const result = await authHooks.beforeRegister({ email, data: insertData, req });
              if (result !== undefined && result !== null) {
                insertData = result as Record<string, unknown>;
              }
            } catch (err) {
              if (err instanceof ApiError) {
                return jsonError(err.code, err.message, err.status);
              }
              return jsonError("AUTH_HOOK_ERROR", "An error occurred in beforeRegister hook", 500);
            }
            // Re-pin security-critical fields so hooks cannot escalate privileges
            insertData.id = id;
            insertData.passwordHash = passwordHash;
          }

          await (db as any).insert(usersTable).values(insertData);

          const createdRows = await (db as any)
            .select()
            .from(usersTable)
            .where(eq(usersTable.id, id));

          const createdUser = createdRows[0];

          // Create session
          const sessionId = await createSession(db, internalSchema, id, config.auth.tokenExpiry);

          if (authHooks?.afterRegister) {
            try {
              await authHooks.afterRegister({
                user: createdUser
                  ? stripSensitiveUserFields(createdUser)
                  : { id, email, role: "user" },
                userId: id,
              });
            } catch (err) {
              console.error("[BunBase] afterRegister hook error:", err);
            }
          }

          // Auto-send email verification if mailer is configured and autoSend is enabled
          if (mailer && config.auth.emailVerification.autoSend) {
            const userColumns = getColumns(usersTable);
            const hasEmailVerified =
              "emailVerified" in userColumns || "email_verified" in userColumns;
            if (hasEmailVerified) {
              // Fire-and-forget — do not block the registration response
              (async () => {
                try {
                  const verificationTokens = internalSchema.verificationTokens;
                  const token = Bun.randomUUIDv7();
                  const tokenHash = await hashToken(token);
                  const tokenId = Bun.randomUUIDv7();
                  const expiresAt = Math.floor(Date.now() / 1000) + 86400; // 24 hours
                  await (db as any).insert(verificationTokens).values({
                    id: tokenId,
                    userId: id,
                    tokenHash,
                    type: "email_verification",
                    expiresAt,
                    createdAt: new Date().toISOString(),
                  });
                  await mailer.sendEmailVerification({ token, email, userId: id });
                } catch (err) {
                  console.error(
                    "[BunBase] Failed to send verification email on registration:",
                    err,
                  );
                }
              })();
            }
          }

          // Set cookies
          const sessionCookie = serializeCookie(
            SESSION_COOKIE,
            sessionId,
            sessionCookieOptions(isDev, cookieDomain),
          );
          const csrf = setCsrfCookie(isDev, cookieDomain);

          return new Response(
            JSON.stringify({
              user: createdUser
                ? stripSensitiveUserFields(createdUser)
                : { id, email, role: "user" },
            }),
            appendResponseCookies(
              {
                status: 201,
                headers: {
                  "Content-Type": "application/json",
                },
              },
              [sessionCookie, csrf.cookie],
            ),
          );
        });
      },
    },

    "/auth/login": {
      async POST(req: Request): Promise<Response> {
        return withRateLimit(req, config.trustedProxies, async () => {
          if (!usersTable) {
            return jsonError("INTERNAL_SERVER_ERROR", "BunBase users table is not configured", 500);
          }

          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
          }

          const valSchema = z.object({
            email: z.email(),
            password: z.string(),
          });

          const result = valSchema.safeParse(body);
          if (!result.success) {
            return jsonError(
              "VALIDATION_ERROR",
              result.error.issues[0]?.message ?? "Invalid input",
              400,
            );
          }

          const { email, password } = result.data;

          if (authHooks?.beforeLogin) {
            try {
              await authHooks.beforeLogin({ email, req });
            } catch (err) {
              if (err instanceof ApiError) {
                return jsonError(err.code, err.message, err.status);
              }
              return jsonError("AUTH_HOOK_ERROR", "An error occurred in beforeLogin hook", 500);
            }
          }

          const rows = await (db as any)
            .select()
            .from(usersTable)
            .where(sql`lower(${usersTable.email}) = lower(${email})`);

          const user = rows[0];
          if (!user) {
            return jsonError("UNAUTHORIZED", "Invalid email or password", 401);
          }

          const passwordHash = resolvePasswordHash(user);
          if (!passwordHash) {
            return jsonError("UNAUTHORIZED", "Invalid email or password", 401);
          }

          const valid = await verifyPassword(password, passwordHash);
          if (!valid) {
            return jsonError("UNAUTHORIZED", "Invalid email or password", 401);
          }

          const sessionId = await createSession(
            db,
            internalSchema,
            String(user.id),
            config.auth.tokenExpiry,
          );

          if (authHooks?.afterLogin) {
            try {
              await authHooks.afterLogin({
                user: stripSensitiveUserFields(user),
                userId: String(user.id),
              });
            } catch (err) {
              console.error("[BunBase] afterLogin hook error:", err);
            }
          }

          const sessionCookie = serializeCookie(
            SESSION_COOKIE,
            sessionId,
            sessionCookieOptions(isDev, cookieDomain),
          );
          const csrf = setCsrfCookie(isDev, cookieDomain);

          return new Response(
            JSON.stringify({
              user: stripSensitiveUserFields(user),
            }),
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
        });
      },
    },

    "/auth/logout": {
      async POST(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const sessionId = extractSessionId(req);
        if (sessionId) {
          await deleteSession(db, internalSchema, sessionId);
        }

        const clearSession = clearCookie(SESSION_COOKIE, isDev, cookieDomain);
        const clearCsrf = clearClientCookie("csrf_token", isDev, cookieDomain);

        return new Response(
          JSON.stringify({ success: true }),
          appendResponseCookies(
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            },
            [clearSession, clearCsrf],
          ),
        );
      },
    },

    "/auth/me": {
      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req, db, internalSchema, usersTable);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        return Response.json({ user: stripSensitiveUserFields(user as unknown as UsersRow) });
      },
    },

    "/auth/change-password": {
      async POST(req: Request): Promise<Response> {
        if (!usersTable) {
          return jsonError("INTERNAL_SERVER_ERROR", "BunBase users table is not configured", 500);
        }

        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req, db, internalSchema, usersTable);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z
          .object({
            currentPassword: z.string(),
            newPassword: z.string().min(8),
          })
          .safeParse(body);
        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }
        const { currentPassword, newPassword } = result.data;

        const rows = await (db as any)
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .limit(1);
        const userRow: UsersRow = rows[0];
        if (!userRow) {
          return jsonError("NOT_FOUND", "User not found", 404);
        }

        const existingHash = resolvePasswordHash(userRow);
        if (!existingHash) {
          return jsonError(
            "BAD_REQUEST",
            "No password set for this account. Use the password reset flow to set one.",
            400,
          );
        }

        const valid = await verifyPassword(currentPassword, existingHash);
        if (!valid) {
          return jsonError("UNAUTHORIZED", "Current password is incorrect", 401);
        }

        const passwordHash = await hashPassword(newPassword);
        await (db as any)
          .update(usersTable)
          .set({ passwordHash })
          .where(eq(usersTable.id, user.id));

        return Response.json({ success: true });
      },
    },
  };
}
