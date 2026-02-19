import { eq, and } from "drizzle-orm";
import type { ResolvedConfig, OAuthProviderConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import type { OAuthProvider } from "./types.ts";
import { google } from "./google.ts";
import { github } from "./github.ts";
import { discord } from "./discord.ts";
import { createSession } from "../sessions.ts";
import {
  appendResponseCookies,
  serializeCookie,
  sessionCookieOptions,
} from "../cookies.ts";
import { setCsrfCookie } from "../csrf.ts";

const SESSION_COOKIE = "tsbase_session";
const OAUTH_STATE_COOKIE = "oauth_state";

const providers: Record<string, OAuthProvider> = { google, github, discord };

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface OAuthRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
}

export function createOAuthRoutes(deps: OAuthRouteDeps) {
  const { db, internalSchema, config, usersTable } = deps;
  const isDev = config.development;
  const oauthConfig = config.auth.oauth;
  const oauthAccounts = internalSchema.oauthAccounts;

  if (!oauthConfig) return {};

  const routes: Record<string, unknown> = {};

  for (const [providerName, provider] of Object.entries(providers)) {
    const providerConfig = oauthConfig[providerName as keyof typeof oauthConfig] as
      | OAuthProviderConfig
      | undefined;
    if (!providerConfig) continue;

    const baseCallbackUrl = isDev
      ? "http://localhost:3000"
      : oauthConfig.redirectUrl ?? "";

    // GET /auth/oauth/:provider → redirect to provider
    routes[`/auth/oauth/${providerName}`] = {
      GET(_req: Request): Response {
        const state = Bun.randomUUIDv7();
        const redirectUri = `${baseCallbackUrl}/auth/oauth/${providerName}/callback`;
        const authUrl = provider.getAuthUrl(
          providerConfig.clientId,
          redirectUri,
          state,
        );

        const stateCookie = `${OAUTH_STATE_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=lax${isDev ? "" : "; Secure"}`;

        return new Response(null, {
          status: 302,
          headers: {
            Location: authUrl,
            "Set-Cookie": stateCookie,
          },
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

        // Verify state
        const cookieHeader = req.headers.get("cookie") ?? "";
        const storedState = cookieHeader
          .split(";")
          .find((c) => c.trim().startsWith(`${OAUTH_STATE_COOKIE}=`))
          ?.split("=")[1]
          ?.trim();

        if (storedState !== state) {
          return jsonError("BAD_REQUEST", "Invalid OAuth state", 400);
        }

        const redirectUri = `${baseCallbackUrl}/auth/oauth/${providerName}/callback`;

        try {
          const { accessToken } = await provider.exchangeCode(
            code,
            providerConfig.clientId,
            providerConfig.clientSecret,
            redirectUri,
          );

          const userInfo = await provider.getUserInfo(accessToken);

          // Check for existing OAuth account link
          const existingOAuthRows = await (db as any)
            .select({ userId: oauthAccounts.userId })
            .from(oauthAccounts)
            .where(
              and(
                eq(oauthAccounts.provider, providerName),
                eq(oauthAccounts.providerAccountId, userInfo.id),
              ),
            )
            ;

          const existingOAuth = existingOAuthRows[0];
          let userId: string;

          if (existingOAuth) {
            userId = existingOAuth.userId;
          } else {
            // Check if user with this email exists
            const existingUserRows = await (db as any)
              .select({ id: usersTable.id })
              .from(usersTable)
              .where(eq(usersTable.email, userInfo.email))
              ;

            const existingUser = existingUserRows[0];

            if (existingUser) {
              userId = existingUser.id;
            } else {
              // Create new user
              userId = Bun.randomUUIDv7();
              const insertData: Record<string, unknown> = {
                id: userId,
                email: userInfo.email,
                passwordHash: null,
                role: "user",
              };
              // Add name if the column exists
              if (usersTable.name) {
                insertData.name = userInfo.name ?? null;
              }
              await (db as any).insert(usersTable).values(insertData);
            }

            // Link OAuth account
            await (db as any)
              .insert(oauthAccounts)
              .values({
                id: Bun.randomUUIDv7(),
                userId,
                provider: providerName,
                providerAccountId: userInfo.id,
                createdAt: new Date().toISOString(),
              })
              ;
          }

          // Create session
          const sessionId = await createSession(
            db,
            internalSchema,
            userId,
            config.auth.tokenExpiry,
          );

          const sessionCookie = serializeCookie(
            SESSION_COOKIE,
            sessionId,
            sessionCookieOptions(isDev),
          );
          const csrf = setCsrfCookie(isDev);
          const clearState = `${OAUTH_STATE_COOKIE}=; Path=/; Max-Age=0`;

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
