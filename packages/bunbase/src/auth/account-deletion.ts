import { eq } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import { deleteUserApiKeys } from "./api-keys.ts";
import { appendResponseCookies, clearClientCookie, clearCookie } from "./cookies.ts";
import { validateCsrf } from "./csrf.ts";
import { isBearerOnly } from "./middleware.ts";
import { verifyPassword } from "./passwords.ts";
import { deleteUserSessions } from "./sessions.ts";

/**
 * Account deletion route with cascading cleanup.
 * @module
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

const SESSION_COOKIE = "bunbase_session";

interface AccountDeletionDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
  authHooks?: AuthHooks;
}

export function createAccountDeletionRoutes(deps: AccountDeletionDeps) {
  const { db, internalSchema, config, usersTable, extractAuth, authHooks } = deps;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;

  return {
    "/auth/delete-account": {
      async POST(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        if (config.auth.accountDeletion.requirePassword) {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
          }

          const { password } = (body as Record<string, unknown>) ?? {};
          if (!password || typeof password !== "string") {
            return jsonError("VALIDATION_ERROR", "Password is required", 400);
          }

          // Verify password
          const userRows = await (db as any)
            .select()
            .from(usersTable)
            .where(eq(usersTable.id, user.id));
          const userRow = userRows[0];
          if (!userRow) {
            return jsonError("NOT_FOUND", "User not found", 404);
          }

          const passwordHash = userRow.password_hash ?? userRow.passwordHash;
          if (typeof passwordHash === "string" && passwordHash.length > 0) {
            const valid = await verifyPassword(password, passwordHash);
            if (!valid) {
              return jsonError("UNAUTHORIZED", "Invalid password", 401);
            }
          }
        }

        // Fire beforeAccountDelete hook
        if (authHooks?.beforeAccountDelete) {
          try {
            await authHooks.beforeAccountDelete({ userId: user.id, req });
          } catch (err: any) {
            if (err?.code && err?.status) {
              return jsonError(err.code, err.message, err.status);
            }
            return jsonError(
              "AUTH_HOOK_ERROR",
              "An error occurred in beforeAccountDelete hook",
              500,
            );
          }
        }

        const userId = user.id;
        const email = user.email;

        // Cascade delete in order
        await deleteUserSessions(db, internalSchema, userId);
        await deleteUserApiKeys(db, internalSchema, userId);
        await (db as any)
          .delete(internalSchema.verificationTokens)
          .where(eq(internalSchema.verificationTokens.userId, userId));
        await (db as any)
          .delete(internalSchema.oauthAccounts)
          .where(eq(internalSchema.oauthAccounts.userId, userId));
        await (db as any)
          .delete(internalSchema.mfaTotp)
          .where(eq(internalSchema.mfaTotp.userId, userId));
        await (db as any)
          .delete(internalSchema.mfaBackupCodes)
          .where(eq(internalSchema.mfaBackupCodes.userId, userId));
        await (db as any)
          .delete(internalSchema.passkeyCredentials)
          .where(eq(internalSchema.passkeyCredentials.userId, userId));

        // Delete org memberships if the table exists
        if ((internalSchema as any).organizationMembers) {
          try {
            await (db as any)
              .delete((internalSchema as any).organizationMembers)
              .where(eq((internalSchema as any).organizationMembers.userId, userId));
          } catch {
            // Table may not exist
          }
        }

        // Delete the user
        await (db as any).delete(usersTable).where(eq(usersTable.id, userId));

        // Fire afterAccountDelete hook
        if (authHooks?.afterAccountDelete) {
          try {
            await authHooks.afterAccountDelete({ userId, email });
          } catch (err) {
            console.error("[BunBase] afterAccountDelete hook error:", err);
          }
        }

        // Clear session cookies
        const clearSession = clearCookie(SESSION_COOKIE, isDev, cookieDomain);
        const clearCsrf = clearClientCookie("csrf_token", isDev, cookieDomain);

        return new Response(
          JSON.stringify({ deleted: true }),
          appendResponseCookies(
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
            [clearSession, clearCsrf],
          ),
        );
      },
    },
  };
}
