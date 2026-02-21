import { eq, and } from "drizzle-orm";
import type { ResolvedConfig, OAuthProviderConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import type { OAuthProvider, CustomOAuthProviderConfig } from "./types.ts";
import { google } from "./google.ts";
import { github } from "./github.ts";
import { discord } from "./discord.ts";
import { createGenericOAuthProvider } from "./generic.ts";
import { createSession } from "../sessions.ts";
import {
  appendResponseCookies,
  serializeCookie,
  sessionCookieOptions,
} from "../cookies.ts";
import { setCsrfCookie, validateCsrf } from "../csrf.ts";
import type { AuthHooks } from "../../hooks/auth-types.ts";
import { ApiError } from "../../api/helpers.ts";
import { extractAuth } from "../middleware.ts";

/**
 * OAuth login/link route factory.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";
const OAUTH_STATE_COOKIE = "oauth_state";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // SQLite: "UNIQUE constraint failed: ..."
  if (typeof e.message === "string" && e.message.toLowerCase().includes("unique constraint failed")) return true;
  // Postgres: error code 23505
  if (e.code === "23505") return true;
  // MySQL: errno 1062 / code ER_DUP_ENTRY
  if (e.errno === 1062 || e.code === "ER_DUP_ENTRY") return true;
  return false;
}

interface OAuthRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  authHooks?: AuthHooks;
}

export function createOAuthRoutes(deps: OAuthRouteDeps) {
  const { db, internalSchema, config, usersTable, authHooks } = deps;
  const isDev = config.development;
  const oauthConfig = config.auth.oauth;
  const oauthAccounts = internalSchema.oauthAccounts;

  if (!oauthConfig) return {};

  // Build the combined providers map: built-ins + custom
  const builtinProviders: Record<string, OAuthProvider> = { google, github, discord };
  const allProviders: Record<string, OAuthProvider> = { ...builtinProviders };
  if (oauthConfig.providers) {
    for (const [name, cfg] of Object.entries(oauthConfig.providers)) {
      allProviders[name] = createGenericOAuthProvider(name, cfg as CustomOAuthProviderConfig);
    }
  }

  // Unified credential lookup: built-in providers use their OAuthProviderConfig,
  // custom providers embed clientId/clientSecret in CustomOAuthProviderConfig.
  function getProviderCredentials(name: string): { clientId: string; clientSecret: string } | undefined {
    const builtinCfg = oauthConfig![name as keyof typeof oauthConfig] as OAuthProviderConfig | undefined;
    if (builtinCfg && "clientId" in builtinCfg) return { clientId: builtinCfg.clientId, clientSecret: builtinCfg.clientSecret };
    const customCfg = oauthConfig!.providers?.[name];
    if (customCfg) return { clientId: customCfg.clientId, clientSecret: customCfg.clientSecret };
    return undefined;
  }

  function buildStateCookie(stateObj: object, dev: boolean): string {
    const value = encodeURIComponent(JSON.stringify(stateObj));
    return `${OAUTH_STATE_COOKIE}=${value}; Path=/; Max-Age=600; HttpOnly; SameSite=lax${dev ? "" : "; Secure"}`;
  }

  function clearStateCookie(dev: boolean): string {
    return `${OAUTH_STATE_COOKIE}=; Path=/; Max-Age=0${dev ? "" : "; Secure"}`;
  }

  /** Extract and parse the state cookie, supporting legacy plain-UUID format. */
  function parseStateCookie(req: Request): { nonce: string; action: string; userId?: string } | null {
    const cookieHeader = req.headers.get("cookie") ?? "";
    const rawPart = cookieHeader
      .split(";")
      .find((c) => c.trim().startsWith(`${OAUTH_STATE_COOKIE}=`));
    if (!rawPart) return null;
    const rawValue = rawPart.trim().slice(OAUTH_STATE_COOKIE.length + 1);
    try {
      return JSON.parse(decodeURIComponent(rawValue));
    } catch {
      // Legacy: plain UUID string — treat as login nonce
      return { nonce: rawValue, action: "login" };
    }
  }

  const routes: Record<string, unknown> = {};

  for (const [providerName, provider] of Object.entries(allProviders)) {
    const providerConfig = getProviderCredentials(providerName);
    if (!providerConfig) continue;

    const baseCallbackUrl = isDev
      ? "http://localhost:3000"
      : oauthConfig.redirectUrl ?? "";

    const redirectUri = `${baseCallbackUrl}/auth/oauth/${providerName}/callback`;

    // GET /auth/oauth/:provider → redirect to provider (login initiation)
    routes[`/auth/oauth/${providerName}`] = {
      GET(_req: Request): Response {
        const nonce = Bun.randomUUIDv7();
        const authUrl = provider.getAuthUrl(providerConfig.clientId, redirectUri, nonce);
        const stateCookie = buildStateCookie({ nonce, action: "login" }, isDev);

        return new Response(null, {
          status: 302,
          headers: {
            Location: authUrl,
            "Set-Cookie": stateCookie,
          },
        });
      },
    };

    // POST /auth/oauth/:provider/link → link initiation (requires active session + CSRF)
    routes[`/auth/oauth/${providerName}/link`] = {
      async POST(req: Request): Promise<Response> {
        if (!validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const currentUser = await extractAuth(req, db, internalSchema, usersTable);
        if (!currentUser) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const nonce = Bun.randomUUIDv7();
        const stateObj = { nonce, action: "link", userId: currentUser.id };
        const stateCookie = buildStateCookie(stateObj, isDev);
        const authUrl = provider.getAuthUrl(providerConfig.clientId, redirectUri, nonce);

        return new Response(null, {
          status: 302,
          headers: { Location: authUrl, "Set-Cookie": stateCookie },
        });
      },
    };

    // GET /auth/oauth/:provider/callback → handle callback
    routes[`/auth/oauth/${providerName}/callback`] = {
      async GET(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
          return jsonError("BAD_REQUEST", "Missing code or state", 400);
        }

        // Parse and verify state cookie
        const parsedState = parseStateCookie(req);
        if (!parsedState || parsedState.nonce !== state) {
          return jsonError("BAD_REQUEST", "Invalid OAuth state", 400);
        }

        const { action } = parsedState;
        const clearState = clearStateCookie(isDev);

        try {
          const { accessToken } = await provider.exchangeCode(
            code,
            providerConfig.clientId,
            providerConfig.clientSecret,
            redirectUri,
          );

          const userInfo = await provider.getUserInfo(accessToken);

          if (authHooks?.beforeOAuthLogin) {
            try {
              await authHooks.beforeOAuthLogin({ provider: providerName, userInfo, req });
            } catch (err) {
              if (err instanceof ApiError) {
                return jsonError(err.code, err.message, err.status);
              }
              return jsonError("AUTH_HOOK_ERROR", "An error occurred in beforeOAuthLogin hook", 500);
            }
          }

          // ── Link flow ─────────────────────────────────────────────────────────
          if (action === "link") {
            // Re-authenticate to confirm the session is still valid
            const currentUser = await extractAuth(req, db, internalSchema, usersTable);
            if (!currentUser) {
              return jsonError("UNAUTHORIZED", "Not authenticated", 401);
            }

            // Verify the authenticated identity matches what was in the state cookie.
            // After this check, use currentUser.id exclusively — do not trust parsedState.userId further.
            if (currentUser.id !== parsedState.userId) {
              return jsonError("FORBIDDEN", "Identity mismatch", 403);
            }

            const targetUserId = currentUser.id;

            // Check if provider account is already linked to any user
            const existingLinkRows = await (db as any)
              .select({ userId: oauthAccounts.userId })
              .from(oauthAccounts)
              .where(
                and(
                  eq(oauthAccounts.provider, providerName),
                  eq(oauthAccounts.providerAccountId, userInfo.id),
                ),
              );

            if (existingLinkRows[0]) {
              return jsonError("CONFLICT", "Provider account already linked to a user", 409);
            }

            await (db as any).insert(oauthAccounts).values({
              id: Bun.randomUUIDv7(),
              userId: targetUserId,
              provider: providerName,
              providerAccountId: userInfo.id,
              createdAt: new Date().toISOString(),
            });

            const redirectTo = oauthConfig.redirectUrl ?? "/";
            return new Response(null, {
              status: 302,
              headers: { Location: `${redirectTo}?linked=true`, "Set-Cookie": clearState },
            });
          }

          // ── Login flow ────────────────────────────────────────────────────────
          // Check for existing OAuth account link by (provider, providerAccountId)
          const existingOAuthRows = await (db as any)
            .select({ userId: oauthAccounts.userId })
            .from(oauthAccounts)
            .where(
              and(
                eq(oauthAccounts.provider, providerName),
                eq(oauthAccounts.providerAccountId, userInfo.id),
              ),
            );

          const existingOAuth = existingOAuthRows[0];
          let userId: string;
          let isNewUser = false;

          if (existingOAuth) {
            userId = existingOAuth.userId;
          } else {
            // Check if a user with this email already exists
            const existingUserRows = await (db as any)
              .select({ id: usersTable.id })
              .from(usersTable)
              .where(eq(usersTable.email, userInfo.email));

            const existingUser = existingUserRows[0];

            if (existingUser) {
              // Email collision: only auto-link when the provider confirms the email is verified.
              // Unverified emails can be set by an attacker → block to prevent account takeover.
              if (userInfo.emailVerified !== true) {
                const redirectTo = oauthConfig.redirectUrl ?? "/";
                return new Response(null, {
                  status: 302,
                  headers: {
                    Location: `${redirectTo}?error=ACCOUNT_LINK_REQUIRED`,
                    "Set-Cookie": clearState,
                  },
                });
              }
              userId = existingUser.id;
            } else {
              // No collision: create a new user
              isNewUser = true;
              userId = Bun.randomUUIDv7();
              const insertData: Record<string, unknown> = {
                id: userId,
                email: userInfo.email,
                passwordHash: null,
                role: "user",
              };
              if (usersTable.name) {
                insertData.name = userInfo.name ?? null;
              }
              await (db as any).insert(usersTable).values(insertData);
            }

            // Link OAuth account — tolerate a race where a concurrent callback
            // already inserted the same (provider, providerAccountId) pair
            try {
              await (db as any)
                .insert(oauthAccounts)
                .values({
                  id: Bun.randomUUIDv7(),
                  userId,
                  provider: providerName,
                  providerAccountId: userInfo.id,
                  createdAt: new Date().toISOString(),
                });
            } catch (linkErr) {
              if (!isUniqueConstraintError(linkErr)) throw linkErr;
              // Unique constraint fired — a concurrent callback already linked this
              // account. Re-query to get the canonical userId.
              const raceRows = await (db as any)
                .select({ userId: oauthAccounts.userId })
                .from(oauthAccounts)
                .where(
                  and(
                    eq(oauthAccounts.provider, providerName),
                    eq(oauthAccounts.providerAccountId, userInfo.id),
                  ),
                );
              if (!raceRows[0]) throw linkErr; // constraint fired but no row found — unexpected
              userId = raceRows[0].userId;
              isNewUser = false;
            }
          }

          // Create session
          const sessionId = await createSession(
            db,
            internalSchema,
            userId,
            config.auth.tokenExpiry,
          );

          if (authHooks?.afterOAuthLogin) {
            try {
              const userRows = await (db as any).select().from(usersTable).where(eq(usersTable.id, userId));
              const oauthUser = userRows[0] ?? { id: userId };
              await authHooks.afterOAuthLogin({ user: oauthUser, userId, provider: providerName, isNewUser });
            } catch (err) {
              console.error(`[BunBase] afterOAuthLogin hook error:`, err);
            }
          }

          const sessionCookie = serializeCookie(
            SESSION_COOKIE,
            sessionId,
            sessionCookieOptions(isDev),
          );
          const csrf = setCsrfCookie(isDev);
          const redirectTo = oauthConfig.redirectUrl ?? "/";

          return new Response(
            null,
            appendResponseCookies(
              {
                status: 302,
                headers: {
                  Location: redirectTo,
                },
              },
              [sessionCookie, csrf.cookie, clearState],
            ),
          );
        } catch (err) {
          console.error(`OAuth ${providerName} error:`, err);
          return jsonError("INTERNAL_ERROR", "OAuth authentication failed", 500);
        }
      },
    };
  }

  return routes;
}
