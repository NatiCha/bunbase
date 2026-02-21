import { eq, lt } from "drizzle-orm";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";

let cleanupCounter = 0;

export async function createSession(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
  ttlSeconds: number = 30 * 24 * 60 * 60,
): Promise<string> {
  const id = Bun.randomUUIDv7();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const createdAt = new Date().toISOString();

  await (db as any)
    .insert(schema.sessions)
    .values({ id, userId, expiresAt, createdAt })
    ;

  return id;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: string;
}

export async function getSession(
  db: AnyDb,
  schema: InternalSchema,
  sessionId: string,
): Promise<SessionRow | null> {
  const sessions = schema.sessions;
  const rows = await (db as any)
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    ;

  const row = rows[0];
  if (!row) return null;

  // Normalize to snake_case for backward compatibility
  const result: SessionRow = {
    id: row.id,
    user_id: row.userId,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
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
  await (db as any)
    .delete(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    ;
}

export async function deleteUserSessions(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
): Promise<void> {
  await (db as any)
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    ;
}

export async function cleanupExpiredSessions(
  db: AnyDb,
  schema: InternalSchema,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await (db as any)
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, now))
    ;
}
