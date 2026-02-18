import type { Database } from "bun:sqlite";

let cleanupCounter = 0;

export function createSession(
  sqlite: Database,
  userId: string,
  ttlSeconds: number = 30 * 24 * 60 * 60,
): string {
  const id = Bun.randomUUIDv7();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const createdAt = new Date().toISOString();

  sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: id,
      $userId: userId,
      $expiresAt: expiresAt,
      $createdAt: createdAt,
    });

  return id;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: string;
}

export function getSession(
  sqlite: Database,
  sessionId: string,
): SessionRow | null {
  const row = sqlite
    .query<SessionRow, { $id: string }>(
      "SELECT * FROM _sessions WHERE id = $id",
    )
    .get({ $id: sessionId });

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    deleteSession(sqlite, sessionId);
    return null;
  }

  // Lazy cleanup every ~100 calls
  cleanupCounter++;
  if (cleanupCounter >= 100) {
    cleanupCounter = 0;
    cleanupExpiredSessions(sqlite);
  }

  return row;
}

export function deleteSession(sqlite: Database, sessionId: string) {
  sqlite
    .query("DELETE FROM _sessions WHERE id = $id")
    .run({ $id: sessionId });
}

export function deleteUserSessions(sqlite: Database, userId: string) {
  sqlite
    .query("DELETE FROM _sessions WHERE user_id = $userId")
    .run({ $userId: userId });
}

export function cleanupExpiredSessions(sqlite: Database) {
  const now = Math.floor(Date.now() / 1000);
  sqlite
    .query("DELETE FROM _sessions WHERE expires_at < $now")
    .run({ $now: now });
}
