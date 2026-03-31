import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import type { AuthUser } from "../../api/types.ts";
import type { ResolvedConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import type { AuthHooks } from "../../hooks/auth-types.ts";
import { decrypt, encrypt, resolveMfaEncryptionKey } from "../encryption.ts";
import { extractSessionId } from "../middleware.ts";
import { verifyPassword } from "../passwords.ts";
import { getSession, updateSessionMfaVerified } from "../sessions.ts";
import { generateBackupCodes, getMfaStatus, storeBackupCodes, verifyBackupCode } from "./index.ts";
import { buildTotpUri, generateSecret, validateTotpCode } from "./totp-core.ts";

/**
 * TOTP (Time-based One-Time Password) MFA routes.
 * @module
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface TotpRouteDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
  authHooks?: AuthHooks;
}

/**
 * Resolve the authenticated user, allowing pending-MFA sessions.
 * Normal extractAuth returns null for pending MFA sessions (except on /auth/mfa/* paths).
 * This helper directly reads the session to get the user for MFA verification routes.
 */
async function extractMfaPendingUser(
  req: Request,
  db: AnyDb,
  internalSchema: InternalSchema,
  usersTable: any,
): Promise<{ user: AuthUser; sessionId: string } | null> {
  const sessionId = extractSessionId(req);
  if (!sessionId) return null;

  const session = await getSession(db, internalSchema, sessionId);
  if (!session) return null;

  // Only allow pending MFA sessions (mfa_verified === 0)
  if (session.mfa_verified !== 0) return null;

  const rows = await (db as any)
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.user_id));

  const user = rows[0];
  if (!user) return null;

  const { id, email, role } = user;
  if (typeof id !== "string" || typeof email !== "string" || typeof role !== "string") {
    return null;
  }

  return { user: { ...user, id, email, role }, sessionId };
}

export function createTotpRoutes(deps: TotpRouteDeps) {
  const { db, internalSchema, config, usersTable, extractAuth, authHooks } = deps;
  const totpConfig = config.auth.mfa.totp;
  const backupConfig = config.auth.mfa.backupCodes;
  const encryptionKey = resolveMfaEncryptionKey(config.auth.mfa.encryptionKey, config.development);

  const routes: Record<string, Record<string, (req: Request) => Response | Promise<Response>>> = {};

  // ─── Setup: Generate TOTP secret ───

  routes["/auth/mfa/totp/setup"] = {
    async POST(req: Request): Promise<Response> {
      const user = await extractAuth(req);
      if (!user) {
        return jsonError("UNAUTHORIZED", "Not authenticated", 401);
      }

      // Check if TOTP is already set up
      const existingRows = await (db as any)
        .select({ id: internalSchema.mfaTotp.id, verified: internalSchema.mfaTotp.verified })
        .from(internalSchema.mfaTotp)
        .where(eq(internalSchema.mfaTotp.userId, user.id));

      if (existingRows[0]?.verified === 1) {
        return jsonError("CONFLICT", "TOTP is already enabled. Disable it first to reconfigure.", 409);
      }

      // Delete any unverified setup
      if (existingRows.length > 0) {
        await (db as any)
          .delete(internalSchema.mfaTotp)
          .where(eq(internalSchema.mfaTotp.userId, user.id));
      }

      const secret = generateSecret();
      const uri = buildTotpUri(secret.base32, totpConfig.issuer, user.email);

      // Encrypt and store the secret
      const encryptedSecret = await encrypt(secret.base32, encryptionKey);

      await (db as any).insert(internalSchema.mfaTotp).values({
        id: Bun.randomUUIDv7(),
        userId: user.id,
        encryptedSecret,
        verified: 0,
        createdAt: new Date().toISOString(),
      });

      return Response.json({
        secret: secret.base32,
        uri,
      });
    },
  };

  // ─── Verify Setup: Confirm with initial code ───

  routes["/auth/mfa/totp/verify-setup"] = {
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

      const schema = z.object({ code: z.string().length(6) });
      const result = schema.safeParse(body);
      if (!result.success) {
        return jsonError("VALIDATION_ERROR", "A 6-digit code is required", 400);
      }

      const { code } = result.data;

      // Load unverified TOTP record
      const totpRows = await (db as any)
        .select()
        .from(internalSchema.mfaTotp)
        .where(
          and(
            eq(internalSchema.mfaTotp.userId, user.id),
            eq(internalSchema.mfaTotp.verified, 0),
          ),
        );

      const totpRow = totpRows[0];
      if (!totpRow) {
        return jsonError("BAD_REQUEST", "No TOTP setup in progress. Call /auth/mfa/totp/setup first.", 400);
      }

      // Decrypt secret and verify code
      const secretBase32 = await decrypt(totpRow.encryptedSecret, encryptionKey);
      const delta = validateTotpCode(secretBase32, code, totpConfig.window);
      if (delta === null) {
        return jsonError("UNAUTHORIZED", "Invalid TOTP code", 401);
      }

      // Mark as verified
      await (db as any)
        .update(internalSchema.mfaTotp)
        .set({ verified: 1 })
        .where(eq(internalSchema.mfaTotp.id, totpRow.id));

      // Generate backup codes
      const codes = generateBackupCodes(backupConfig.count, backupConfig.length);
      await storeBackupCodes(db, internalSchema, user.id, codes);

      if (authHooks?.afterMfaSetup) {
        try {
          await authHooks.afterMfaSetup({ userId: user.id, method: "totp" });
        } catch (err) {
          console.error("[BunBase] afterMfaSetup hook error:", err);
        }
      }

      return Response.json({ backupCodes: codes });
    },
  };

  // ─── Verify: Complete MFA challenge during login ───

  routes["/auth/mfa/totp/verify"] = {
    async POST(req: Request): Promise<Response> {
      // This route accepts pending-MFA sessions
      const pending = await extractMfaPendingUser(req, db, internalSchema, usersTable);
      if (!pending) {
        return jsonError("UNAUTHORIZED", "No pending MFA session", 401);
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
      }

      const schema = z.object({ code: z.string().length(6) });
      const result = schema.safeParse(body);
      if (!result.success) {
        return jsonError("VALIDATION_ERROR", "A 6-digit code is required", 400);
      }

      const { code } = result.data;

      // Load TOTP secret
      const totpRows = await (db as any)
        .select()
        .from(internalSchema.mfaTotp)
        .where(
          and(
            eq(internalSchema.mfaTotp.userId, pending.user.id),
            eq(internalSchema.mfaTotp.verified, 1),
          ),
        );

      const totpRow = totpRows[0];
      if (!totpRow) {
        return jsonError("BAD_REQUEST", "TOTP not configured for this account", 400);
      }

      const secretBase32 = await decrypt(totpRow.encryptedSecret, encryptionKey);
      const delta = validateTotpCode(secretBase32, code, totpConfig.window);
      if (delta === null) {
        return jsonError("UNAUTHORIZED", "Invalid TOTP code", 401);
      }

      // Upgrade session to fully verified
      await updateSessionMfaVerified(db, internalSchema, pending.sessionId, 1);

      if (authHooks?.afterMfaVerify) {
        try {
          await authHooks.afterMfaVerify({ userId: pending.user.id, method: "totp" });
        } catch (err) {
          console.error("[BunBase] afterMfaVerify hook error:", err);
        }
      }

      // Strip sensitive fields from user
      const { passwordHash, password_hash, ...safeUser } = pending.user as unknown as Record<string, unknown>;

      return Response.json({ user: safeUser });
    },
  };

  // ─── Backup Code Verify: Use a backup code during MFA challenge ───

  routes["/auth/mfa/backup/verify"] = {
    async POST(req: Request): Promise<Response> {
      const pending = await extractMfaPendingUser(req, db, internalSchema, usersTable);
      if (!pending) {
        return jsonError("UNAUTHORIZED", "No pending MFA session", 401);
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
      }

      const schema = z.object({ code: z.string() });
      const result = schema.safeParse(body);
      if (!result.success) {
        return jsonError("VALIDATION_ERROR", "Backup code required", 400);
      }

      const valid = await verifyBackupCode(db, internalSchema, pending.user.id, result.data.code);
      if (!valid) {
        return jsonError("UNAUTHORIZED", "Invalid backup code", 401);
      }

      // Upgrade session
      await updateSessionMfaVerified(db, internalSchema, pending.sessionId, 1);

      if (authHooks?.afterMfaVerify) {
        try {
          await authHooks.afterMfaVerify({ userId: pending.user.id, method: "backup_code" });
        } catch (err) {
          console.error("[BunBase] afterMfaVerify hook error:", err);
        }
      }

      const { passwordHash, password_hash, ...safeUser } = pending.user as unknown as Record<string, unknown>;

      return Response.json({ user: safeUser });
    },
  };

  // ─── Disable TOTP ───

  routes["/auth/mfa/totp/disable"] = {
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

      const schema = z.object({ password: z.string() });
      const result = schema.safeParse(body);
      if (!result.success) {
        return jsonError("VALIDATION_ERROR", "Password required to disable TOTP", 400);
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

      const hash = userRow.passwordHash ?? userRow.password_hash;
      if (!hash || !(await verifyPassword(result.data.password, hash))) {
        return jsonError("UNAUTHORIZED", "Invalid password", 401);
      }

      // Delete TOTP and backup codes
      await (db as any)
        .delete(internalSchema.mfaTotp)
        .where(eq(internalSchema.mfaTotp.userId, user.id));

      await (db as any)
        .delete(internalSchema.mfaBackupCodes)
        .where(eq(internalSchema.mfaBackupCodes.userId, user.id));

      if (authHooks?.afterMfaDisable) {
        try {
          await authHooks.afterMfaDisable({ userId: user.id, method: "totp" });
        } catch (err) {
          console.error("[BunBase] afterMfaDisable hook error:", err);
        }
      }

      return Response.json({ success: true });
    },
  };

  // ─── Regenerate Backup Codes ───

  routes["/auth/mfa/backup/regenerate"] = {
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

      const schema = z.object({ password: z.string() });
      const result = schema.safeParse(body);
      if (!result.success) {
        return jsonError("VALIDATION_ERROR", "Password required", 400);
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

      const hash = userRow.passwordHash ?? userRow.password_hash;
      if (!hash || !(await verifyPassword(result.data.password, hash))) {
        return jsonError("UNAUTHORIZED", "Invalid password", 401);
      }

      const codes = generateBackupCodes(backupConfig.count, backupConfig.length);
      await storeBackupCodes(db, internalSchema, user.id, codes);

      return Response.json({ backupCodes: codes });
    },
  };

  // ─── MFA Status ───

  routes["/auth/mfa/status"] = {
    async GET(req: Request): Promise<Response> {
      const user = await extractAuth(req);
      if (!user) {
        return jsonError("UNAUTHORIZED", "Not authenticated", 401);
      }

      const status = await getMfaStatus(db, internalSchema, user.id);
      return Response.json(status);
    },
  };

  return routes;
}
