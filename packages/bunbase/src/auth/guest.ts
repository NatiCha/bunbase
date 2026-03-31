import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import {
  appendResponseCookies,
  serializeCookie,
  sessionCookieOptions,
} from "./cookies.ts";
import { setCsrfCookie } from "./csrf.ts";
import { extractAuth } from "./middleware.ts";
import { hashPassword } from "./passwords.ts";
import { getSession } from "./sessions.ts";
import { extractSessionId } from "./middleware.ts";

/**
 * Anonymous/guest auth routes.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface GuestAuthDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  authHooks?: AuthHooks;
}

export function createGuestRoutes(deps: GuestAuthDeps) {
  const { db, internalSchema, config, usersTable, authHooks } = deps;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;
  const guestTtl = config.auth.guestAuth.ttl;

  return {
    "/auth/guest": {
      async POST(_req: Request): Promise<Response> {
        const guestUuid = Bun.randomUUIDv7();
        const guestId = `guest:${guestUuid}`;
        const sessionId = Bun.randomUUIDv7();
        const expiresAt = Math.floor(Date.now() / 1000) + guestTtl;
        const createdAt = new Date().toISOString();

        await (db as any).insert(internalSchema.sessions).values({
          id: sessionId,
          userId: guestId,
          expiresAt,
          createdAt,
          isGuest: 1,
        });

        if (authHooks?.afterGuestCreate) {
          try {
            await authHooks.afterGuestCreate({ guestId: guestUuid });
          } catch (err) {
            console.error("[BunBase] afterGuestCreate hook error:", err);
          }
        }

        const sessionCookie = serializeCookie(
          SESSION_COOKIE,
          sessionId,
          sessionCookieOptions(isDev, cookieDomain),
        );
        const csrf = setCsrfCookie(isDev, cookieDomain);

        return new Response(
          JSON.stringify({ guestId: guestUuid }),
          appendResponseCookies(
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            },
            [sessionCookie, csrf.cookie],
          ),
        );
      },
    },

    "/auth/guest/convert": {
      async POST(req: Request): Promise<Response> {
        if (!usersTable) {
          return jsonError("INTERNAL_SERVER_ERROR", "Users table not configured", 500);
        }

        const sessionId = extractSessionId(req);
        if (!sessionId) {
          return jsonError("UNAUTHORIZED", "No active session", 401);
        }

        const session = await getSession(db, internalSchema, sessionId);
        if (!session) {
          return jsonError("UNAUTHORIZED", "Invalid session", 401);
        }

        if (session.is_guest !== 1) {
          return jsonError("BAD_REQUEST", "Not a guest session", 400);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z
          .object({
            email: z.email(),
            password: z.string().min(8),
          })
          .safeParse(body);

        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }

        const { email, password } = result.data;

        // Check existing user
        const existing = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(sql`lower(${usersTable.email}) = lower(${email})`);

        if (existing.length > 0) {
          return jsonError("CONFLICT", "Email already registered", 409);
        }

        const userId = Bun.randomUUIDv7();
        const passwordHash = await hashPassword(password);

        await (db as any).insert(usersTable).values({
          id: userId,
          email,
          passwordHash,
          role: "user",
        });

        // Update session: set real userId, clear guest flag, extend TTL
        const newExpiresAt = Math.floor(Date.now() / 1000) + config.auth.tokenExpiry;
        await (db as any)
          .update(internalSchema.sessions)
          .set({ userId, isGuest: 0, expiresAt: newExpiresAt })
          .where(eq(internalSchema.sessions.id, sessionId));

        const createdRows = await (db as any)
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, userId));
        const createdUser = createdRows[0];

        const guestUuid = session.user_id.replace(/^guest:/, "");

        if (authHooks?.afterGuestConvert) {
          try {
            await authHooks.afterGuestConvert({ guestId: guestUuid, userId, email });
          } catch (err) {
            console.error("[BunBase] afterGuestConvert hook error:", err);
          }
        }

        const sanitized = { ...createdUser };
        delete sanitized.password_hash;
        delete sanitized.passwordHash;

        return Response.json({ user: sanitized });
      },
    },
  };
}
