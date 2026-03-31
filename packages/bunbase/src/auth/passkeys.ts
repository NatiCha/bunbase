import { and, eq, gt } from "drizzle-orm";
import { z } from "zod/v4";
import type { AuthUser } from "../api/types.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import { appendResponseCookies, serializeCookie, sessionCookieOptions } from "./cookies.ts";
import { setCsrfCookie } from "./csrf.ts";
import { createSession } from "./sessions.ts";
import { hashToken } from "./tokens.ts";

/**
 * WebAuthn/Passkey registration and authentication routes.
 * @module
 */

const SESSION_COOKIE = "bunbase_session";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface PasskeyRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
  authHooks?: AuthHooks;
}

export function createPasskeyRoutes(deps: PasskeyRouteDeps) {
  const { db, internalSchema, config, usersTable, extractAuth, authHooks } = deps;
  const isDev = config.development;
  const cookieDomain = config.cookieDomain;
  const passkeyConfig = config.auth.mfa.passkeys;
  const tokens = internalSchema.verificationTokens;
  const credentials = internalSchema.passkeyCredentials;

  const routes: Record<string, Record<string, (req: Request) => Response | Promise<Response>>> = {};

  // ─── Registration: Generate Options ───

  routes["/auth/passkeys/register/options"] = {
    async POST(req: Request): Promise<Response> {
      const user = await extractAuth(req);
      if (!user) {
        return jsonError("UNAUTHORIZED", "Not authenticated", 401);
      }

      const { generateRegistrationOptions } = await import("@simplewebauthn/server");

      // Get existing credentials for this user (to exclude)
      const existingCreds = await (db as any)
        .select({ id: credentials.id, transports: credentials.transports })
        .from(credentials)
        .where(eq(credentials.userId, user.id));

      const excludeCredentials = existingCreds.map((c: any) => ({
        id: c.id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      }));

      const options = await generateRegistrationOptions({
        rpName: passkeyConfig.rpName ?? "BunBase",
        rpID: passkeyConfig.rpId ?? new URL(req.url).hostname,
        userName: user.email,
        userDisplayName: user.email,
        excludeCredentials,
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
          ...(passkeyConfig.authenticatorAttachment
            ? { authenticatorAttachment: passkeyConfig.authenticatorAttachment }
            : {}),
        },
      });

      // Store challenge in verification tokens
      const challengeHash = await hashToken(options.challenge);
      await (db as any).insert(tokens).values({
        id: Bun.randomUUIDv7(),
        userId: user.id,
        tokenHash: challengeHash,
        type: "passkey_registration",
        expiresAt: Math.floor(Date.now() / 1000) + 300, // 5 min
        createdAt: new Date().toISOString(),
      });

      return Response.json(options);
    },
  };

  // ─── Registration: Verify Response ───

  routes["/auth/passkeys/register/verify"] = {
    async POST(req: Request): Promise<Response> {
      const user = await extractAuth(req);
      if (!user) {
        return jsonError("UNAUTHORIZED", "Not authenticated", 401);
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
      }

      const schema = z.object({
        response: z.record(z.string(), z.unknown()),
        name: z.string().optional(),
      });
      const parseResult = schema.safeParse(body);
      if (!parseResult.success) {
        return jsonError("VALIDATION_ERROR", "Invalid attestation response", 400);
      }

      // Find the challenge
      const now = Math.floor(Date.now() / 1000);
      const challengeRows = await (db as any)
        .select({ id: tokens.id, tokenHash: tokens.tokenHash })
        .from(tokens)
        .where(
          and(
            eq(tokens.userId, user.id),
            eq(tokens.type, "passkey_registration"),
            gt(tokens.expiresAt, now),
          ),
        );

      const challengeRow = challengeRows[0];
      if (!challengeRow) {
        return jsonError("BAD_REQUEST", "No pending registration challenge", 400);
      }

      // We need the original challenge to verify. Since we stored the hash,
      // the challenge must be passed from the client (it's in the attestation response).
      // SimpleWebAuthn extracts it from the response automatically.

      const { verifyRegistrationResponse } = await import("@simplewebauthn/server");

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: parseResult.data.response as any,
          expectedChallenge: async (challenge: string) => {
            // Verify the challenge matches what we stored
            const hash = await hashToken(challenge);
            return hash === challengeRow.tokenHash;
          },
          expectedOrigin: passkeyConfig.origin ?? new URL(req.url).origin,
          expectedRPID: passkeyConfig.rpId ?? new URL(req.url).hostname,
        });
      } catch (err: any) {
        return jsonError("BAD_REQUEST", err?.message ?? "Registration verification failed", 400);
      }

      if (!verification.verified || !verification.registrationInfo) {
        return jsonError("BAD_REQUEST", "Registration verification failed", 400);
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;

      // Store credential
      await (db as any).insert(credentials).values({
        id: credential.id,
        userId: user.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp ? 1 : 0,
        transports: credential.transports ? JSON.stringify(credential.transports) : null,
        name: parseResult.data.name ?? "Passkey",
        createdAt: new Date().toISOString(),
      });

      // Delete used challenge
      await (db as any).delete(tokens).where(eq(tokens.id, challengeRow.id));

      if (authHooks?.afterPasskeyRegister) {
        try {
          await authHooks.afterPasskeyRegister({
            userId: user.id,
            credentialId: credential.id,
          });
        } catch (err) {
          console.error("[BunBase] afterPasskeyRegister hook error:", err);
        }
      }

      return Response.json({ verified: true, credentialId: credential.id });
    },
  };

  // ─── Authentication: Generate Options ───

  routes["/auth/passkeys/login/options"] = {
    async POST(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = {};
      }

      const schema = z.object({ email: z.string().optional() });
      const parseResult = schema.safeParse(body);
      const email = parseResult.success ? parseResult.data.email : undefined;

      const { generateAuthenticationOptions } = await import("@simplewebauthn/server");

      let allowCredentials: { id: string; transports?: any[] }[] | undefined;

      if (email) {
        // Find user and their credentials
        const userRows = await (db as any)
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));

        const user = userRows[0];
        if (user) {
          const userCreds = await (db as any)
            .select({ id: credentials.id, transports: credentials.transports })
            .from(credentials)
            .where(eq(credentials.userId, user.id));

          allowCredentials = userCreds.map((c: any) => ({
            id: c.id,
            transports: c.transports ? JSON.parse(c.transports) : undefined,
          }));
        }
      }

      const authOpts: Parameters<typeof generateAuthenticationOptions>[0] = {
        rpID: passkeyConfig.rpId ?? new URL(req.url).hostname,
        allowCredentials,
        userVerification: "preferred",
      };

      const options = await generateAuthenticationOptions(authOpts);

      // Hint the browser to prefer the configured authenticator type
      if (passkeyConfig.authenticatorAttachment === "platform") {
        (options as any).hints = ["client-device"];
      } else if (passkeyConfig.authenticatorAttachment === "cross-platform") {
        (options as any).hints = ["security-key"];
      }

      // Store challenge — use a placeholder userId since we don't know who's authenticating yet
      const challengeHash = await hashToken(options.challenge);
      await (db as any).insert(tokens).values({
        id: Bun.randomUUIDv7(),
        userId: "__passkey_auth__",
        tokenHash: challengeHash,
        type: "passkey_authentication",
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
      });

      return Response.json(options);
    },
  };

  // ─── Authentication: Verify Response ───

  routes["/auth/passkeys/login/verify"] = {
    async POST(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
      }

      const response = body as Record<string, unknown>;
      const credentialId = response?.id as string;
      if (!credentialId) {
        return jsonError("BAD_REQUEST", "Missing credential ID", 400);
      }

      // Look up the credential
      const credRows = await (db as any)
        .select()
        .from(credentials)
        .where(eq(credentials.id, credentialId));

      const credRow = credRows[0];
      if (!credRow) {
        return jsonError("UNAUTHORIZED", "Unknown credential", 401);
      }

      // Find the challenge
      const now = Math.floor(Date.now() / 1000);
      const challengeRows = await (db as any)
        .select({ id: tokens.id, tokenHash: tokens.tokenHash })
        .from(tokens)
        .where(
          and(
            eq(tokens.userId, "__passkey_auth__"),
            eq(tokens.type, "passkey_authentication"),
            gt(tokens.expiresAt, now),
          ),
        );

      if (challengeRows.length === 0) {
        return jsonError("BAD_REQUEST", "No pending authentication challenge", 400);
      }

      const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");

      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      let matchedChallengeId: string | null = null;

      try {
        verification = await verifyAuthenticationResponse({
          response: response as any,
          expectedChallenge: async (challenge: string) => {
            const hash = await hashToken(challenge);
            const match = challengeRows.find((r: any) => r.tokenHash === hash);
            if (match) {
              matchedChallengeId = match.id;
              return true;
            }
            return false;
          },
          expectedOrigin: passkeyConfig.origin ?? new URL(req.url).origin,
          expectedRPID: passkeyConfig.rpId ?? new URL(req.url).hostname,
          credential: {
            id: credRow.id,
            publicKey: new Uint8Array(Buffer.from(credRow.publicKey, "base64url")),
            counter: credRow.counter,
            transports: credRow.transports ? JSON.parse(credRow.transports) : undefined,
          },
        });
      } catch (err: any) {
        return jsonError("UNAUTHORIZED", err?.message ?? "Authentication failed", 401);
      }

      if (!verification.verified) {
        return jsonError("UNAUTHORIZED", "Authentication verification failed", 401);
      }

      // Update counter and last used
      await (db as any)
        .update(credentials)
        .set({
          counter: verification.authenticationInfo.newCounter,
          lastUsedAt: new Date().toISOString(),
        })
        .where(eq(credentials.id, credRow.id));

      // Delete used challenge
      if (matchedChallengeId) {
        await (db as any).delete(tokens).where(eq(tokens.id, matchedChallengeId));
      }

      // Look up user
      const userRows = await (db as any)
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, credRow.userId));

      const user = userRows[0];
      if (!user) {
        return jsonError("UNAUTHORIZED", "User not found", 401);
      }

      // Create a fully verified session (passkey is strong auth, satisfies MFA)
      const sessionId = await createSession(
        db,
        internalSchema,
        String(user.id),
        config.auth.tokenExpiry,
        1, // mfaVerified = 1
      );

      const sessionCookie = serializeCookie(
        SESSION_COOKIE,
        sessionId,
        sessionCookieOptions(isDev, cookieDomain),
      );
      const csrf = setCsrfCookie(isDev, cookieDomain);

      if (authHooks?.afterPasskeyLogin) {
        try {
          await authHooks.afterPasskeyLogin({
            userId: String(user.id),
            credentialId: credRow.id,
          });
        } catch (err) {
          console.error("[BunBase] afterPasskeyLogin hook error:", err);
        }
      }

      const { passwordHash, password_hash, ...safeUser } = user;

      return new Response(
        JSON.stringify({ user: safeUser }),
        appendResponseCookies({ status: 200, headers: { "Content-Type": "application/json" } }, [
          sessionCookie,
          csrf.cookie,
        ]),
      );
    },
  };

  // ─── List Passkeys ───

  routes["/auth/passkeys"] = {
    async GET(req: Request): Promise<Response> {
      const user = await extractAuth(req);
      if (!user) {
        return jsonError("UNAUTHORIZED", "Not authenticated", 401);
      }

      const rows = await (db as any)
        .select({
          id: credentials.id,
          name: credentials.name,
          deviceType: credentials.deviceType,
          backedUp: credentials.backedUp,
          createdAt: credentials.createdAt,
          lastUsedAt: credentials.lastUsedAt,
        })
        .from(credentials)
        .where(eq(credentials.userId, user.id));

      return Response.json({ passkeys: rows });
    },
  };

  // ─── Delete Passkey ───
  // Pattern-based route: /auth/passkeys/:id
  // This needs to be handled as a pattern match, so we'll use a different approach

  routes["/auth/passkeys/delete"] = {
    async POST(req: Request): Promise<Response> {
      const user = await extractAuth(req);
      if (!user) {
        return jsonError("UNAUTHORIZED", "Not authenticated", 401);
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
      }

      const schema = z.object({ id: z.string() });
      const result = schema.safeParse(body);
      if (!result.success) {
        return jsonError("VALIDATION_ERROR", "Credential ID required", 400);
      }

      const credId = result.data.id;

      // Verify the credential belongs to this user
      const credRows = await (db as any)
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.id, credId), eq(credentials.userId, user.id)));

      if (credRows.length === 0) {
        return jsonError("NOT_FOUND", "Passkey not found", 404);
      }

      await (db as any)
        .delete(credentials)
        .where(and(eq(credentials.id, credId), eq(credentials.userId, user.id)));

      if (authHooks?.afterPasskeyRemove) {
        try {
          await authHooks.afterPasskeyRemove({ userId: user.id, credentialId: credId });
        } catch (err) {
          console.error("[BunBase] afterPasskeyRemove hook error:", err);
        }
      }

      return Response.json({ deleted: true });
    },
  };

  return routes;
}
