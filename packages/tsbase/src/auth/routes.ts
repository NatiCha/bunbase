import { eq, getColumns } from "drizzle-orm";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { Column } from "drizzle-orm";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { createSession, deleteSession } from "./sessions.ts";
import {
  appendResponseCookies,
  serializeCookie,
  sessionCookieOptions,
  clearCookie,
  clearClientCookie,
} from "./cookies.ts";
import { setCsrfCookie, validateCsrf } from "./csrf.ts";
import { checkRateLimit, getClientIp } from "./rate-limit.ts";
import { extractAuth, extractSessionId } from "./middleware.ts";
import { z } from "zod/v4";

const SESSION_COOKIE = "tsbase_session";
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
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function withRateLimit(
  req: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const ip = getClientIp(req);
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

export function createAuthRoutes(deps: AuthRouteDeps) {
  const { db, internalSchema, config, usersTable } = deps;
  const isDev = config.development;
  const { byInputField, requiredSignupColumns } = getUsersColumns(usersTable);

  return {
    "/auth/register": {
      async POST(req: Request): Promise<Response> {
        return withRateLimit(req, async () => {
          if (!usersTable) {
            return jsonError(
              "INTERNAL_SERVER_ERROR",
              "TSBase users table is not configured",
              500,
            );
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
              return jsonError(
                "BAD_REQUEST",
                `Field "${field}" cannot be set during signup`,
                400,
              );
            }

            const columnInfo = byInputField.get(field);
            if (!columnInfo) {
              return jsonError(
                "BAD_REQUEST",
                `Unknown users field "${field}"`,
                400,
              );
            }

            if (
              BLOCKED_SIGNUP_FIELDS.has(columnInfo.key) ||
              BLOCKED_SIGNUP_FIELDS.has((columnInfo.column as any).name)
            ) {
              return jsonError(
                "BAD_REQUEST",
                `Field "${field}" cannot be set during signup`,
                400,
              );
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
            .where(eq(usersTable.email, email))
            ;

          if (existingRows.length > 0) {
            return jsonError("CONFLICT", "Email already registered", 409);
          }

          const id = Bun.randomUUIDv7();
          const passwordHash = await hashPassword(password);

          const insertData: Record<string, unknown> = {
            id,
            email,
            passwordHash: passwordHash,
            role: "user",
            ...signupExtrasByKey,
          };

          await (db as any).insert(usersTable).values(insertData);

          const createdRows = await (db as any)
            .select()
            .from(usersTable)
            .where(eq(usersTable.id, id))
            ;

          const createdUser = createdRows[0];

          // Create session
          const sessionId = await createSession(db, internalSchema, id, config.auth.tokenExpiry);

          // Set cookies
          const sessionCookie = serializeCookie(
            SESSION_COOKIE,
            sessionId,
            sessionCookieOptions(isDev),
          );
          const csrf = setCsrfCookie(isDev);

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
        return withRateLimit(req, async () => {
          if (!usersTable) {
            return jsonError(
              "INTERNAL_SERVER_ERROR",
              "TSBase users table is not configured",
              500,
            );
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

          const rows = await (db as any)
            .select()
            .from(usersTable)
            .where(eq(usersTable.email, email))
            ;

          const user = rows[0];
          if (!user) {
            return jsonError("UNAUTHORIZED", "Invalid email or password", 401);
          }

          const passwordHash = resolvePasswordHash(user);
          if (!passwordHash) {
            return jsonError(
              "UNAUTHORIZED",
              "This account uses OAuth login. Please sign in with your provider.",
              401,
            );
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

          const sessionCookie = serializeCookie(
            SESSION_COOKIE,
            sessionId,
            sessionCookieOptions(isDev),
          );
          const csrf = setCsrfCookie(isDev);

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
        if (!validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const sessionId = extractSessionId(req);
        if (sessionId) {
          await deleteSession(db, internalSchema, sessionId);
        }

        const clearSession = clearCookie(SESSION_COOKIE, isDev);
        const clearCsrf = clearClientCookie("csrf_token", isDev);

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

        return Response.json({ user: stripSensitiveUserFields(user as UsersRow) });
      },
    },
  };
}
