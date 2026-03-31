import { and, eq } from "drizzle-orm";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import { hashToken } from "../tokens.ts";

/**
 * Shared MFA utilities: status checks, backup code generation and verification.
 * @module
 */

/**
 * Check MFA enrollment status for a user.
 */
export async function getMfaStatus(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
): Promise<{ totp: boolean; passkeys: number }> {
  const totpRows = await (db as any)
    .select({ id: schema.mfaTotp.id })
    .from(schema.mfaTotp)
    .where(and(eq(schema.mfaTotp.userId, userId), eq(schema.mfaTotp.verified, 1)));

  const passkeyRows = await (db as any)
    .select({ id: schema.passkeyCredentials.id })
    .from(schema.passkeyCredentials)
    .where(eq(schema.passkeyCredentials.userId, userId));

  return {
    totp: totpRows.length > 0,
    passkeys: passkeyRows.length,
  };
}

/**
 * Generate N random alphanumeric backup codes.
 */
export function generateBackupCodes(count: number, length: number): string[] {
  const charset = "abcdefghjkmnpqrstuvwxyz23456789"; // No confusing chars (0/o, 1/l, i)
  const codes: string[] = [];

  for (let i = 0; i < count; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let code = "";
    for (let j = 0; j < length; j++) {
      code += charset[bytes[j]! % charset.length];
    }
    codes.push(code);
  }

  return codes;
}

/**
 * Store backup codes as SHA-256 hashes. Deletes any existing codes for the user.
 */
export async function storeBackupCodes(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
  codes: string[],
): Promise<void> {
  // Delete existing codes
  await (db as any).delete(schema.mfaBackupCodes).where(eq(schema.mfaBackupCodes.userId, userId));

  const now = new Date().toISOString();

  for (const code of codes) {
    const codeHash = await hashToken(code);
    await (db as any).insert(schema.mfaBackupCodes).values({
      id: Bun.randomUUIDv7(),
      userId,
      codeHash,
      used: 0,
      createdAt: now,
    });
  }
}

/**
 * Verify a backup code. Returns true if valid (and marks it as used).
 */
export async function verifyBackupCode(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
  code: string,
): Promise<boolean> {
  const codeHash = await hashToken(code.toLowerCase().replace(/\s+/g, ""));

  const rows = await (db as any)
    .select({ id: schema.mfaBackupCodes.id })
    .from(schema.mfaBackupCodes)
    .where(
      and(
        eq(schema.mfaBackupCodes.userId, userId),
        eq(schema.mfaBackupCodes.codeHash, codeHash),
        eq(schema.mfaBackupCodes.used, 0),
      ),
    );

  const row = rows[0];
  if (!row) return false;

  // Mark as used
  await (db as any)
    .update(schema.mfaBackupCodes)
    .set({ used: 1 })
    .where(eq(schema.mfaBackupCodes.id, row.id));

  return true;
}
