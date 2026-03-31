import { eq, lt } from "drizzle-orm";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";

let cleanupCounter = 0;

export interface CreateSessionOptions {
  mfaVerified?: number | null;
  userAgent?: string;
  ipAddress?: string;
  isGuest?: number;
}

export async function createSession(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
  ttlSeconds: number = 30 * 24 * 60 * 60,
  mfaVerifiedOrOpts?: number | null | CreateSessionOptions,
): Promise<string> {
  const id = Bun.randomUUIDv7();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const createdAt = new Date().toISOString();

  const values: Record<string, unknown> = { id, userId, expiresAt, createdAt };

  if (typeof mfaVerifiedOrOpts === "object" && mfaVerifiedOrOpts !== null) {
    const opts = mfaVerifiedOrOpts;
    if (opts.mfaVerified !== undefined) values.mfaVerified = opts.mfaVerified;
    if (opts.userAgent) values.userAgent = opts.userAgent;
    if (opts.ipAddress) values.ipAddress = opts.ipAddress;
    if (opts.isGuest !== undefined) values.isGuest = opts.isGuest;
  } else if (mfaVerifiedOrOpts !== undefined) {
    values.mfaVerified = mfaVerifiedOrOpts;
  }

  await (db as any).insert(schema.sessions).values(values);

  return id;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  mfa_verified: number | null;
  created_at: string;
  user_agent: string | null;
  ip_address: string | null;
  is_guest: number | null;
}

export async function getSession(
  db: AnyDb,
  schema: InternalSchema,
  sessionId: string,
): Promise<SessionRow | null> {
  const sessions = schema.sessions;
  const rows = await (db as any).select().from(sessions).where(eq(sessions.id, sessionId));

  const row = rows[0];
  if (!row) return null;

  // Normalize to snake_case for backward compatibility
  const result: SessionRow = {
    id: row.id,
    user_id: row.userId,
    expires_at: row.expiresAt,
    mfa_verified: row.mfaVerified ?? row.mfa_verified ?? null,
    created_at: row.createdAt,
    user_agent: row.userAgent ?? row.user_agent ?? null,
    ip_address: row.ipAddress ?? row.ip_address ?? null,
    is_guest: row.isGuest ?? row.is_guest ?? null,
  };

  const now = Math.floor(Date.now() / 1000);
  if (result.expires_at < now) {
    await deleteSession(db, schema, sessionId);
    return null;
  }

  // Lazy cleanup every ~100 calls
  cleanupCounter++;
  if (cleanupCounter >= 100) {
    cleanupCounter = 0;
    await cleanupExpiredSessions(db, schema);
  }

  return result;
}

export async function deleteSession(
  db: AnyDb,
  schema: InternalSchema,
  sessionId: string,
): Promise<void> {
  await (db as any).delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

export async function deleteUserSessions(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
): Promise<void> {
  await (db as any).delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

export async function updateSessionMfaVerified(
  db: AnyDb,
  schema: InternalSchema,
  sessionId: string,
  mfaVerified: number,
): Promise<void> {
  await (db as any)
    .update(schema.sessions)
    .set({ mfaVerified })
    .where(eq(schema.sessions.id, sessionId));
}

export async function cleanupExpiredSessions(db: AnyDb, schema: InternalSchema): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await (db as any).delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
}
