import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  cleanupExpiredSessions,
} from "../auth/sessions.ts";

function setupDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE _sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return sqlite;
}

test("createSession returns a non-empty session id", () => {
  const sqlite = setupDb();
  const id = createSession(sqlite, "user-1");
  expect(typeof id).toBe("string");
  expect(id.length).toBeGreaterThan(0);
  sqlite.close();
});

test("getSession retrieves a freshly created session", () => {
  const sqlite = setupDb();
  const sessionId = createSession(sqlite, "user-2");
  const session = getSession(sqlite, sessionId);
  expect(session).not.toBeNull();
  expect(session?.user_id).toBe("user-2");
  sqlite.close();
});

test("getSession returns null for unknown session id", () => {
  const sqlite = setupDb();
  const session = getSession(sqlite, "nonexistent-id");
  expect(session).toBeNull();
  sqlite.close();
});

test("getSession returns null and removes expired session", () => {
  const sqlite = setupDb();
  // Insert a session that expired 1 second ago
  const id = "expired-session";
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: id,
      $userId: "user-3",
      $expiresAt: expiredAt,
      $createdAt: new Date().toISOString(),
    });

  const session = getSession(sqlite, id);
  expect(session).toBeNull();

  // Confirm the expired row was deleted
  const row = sqlite
    .query<{ id: string }, { $id: string }>(
      "SELECT id FROM _sessions WHERE id = $id",
    )
    .get({ $id: id });
  expect(row).toBeNull();

  sqlite.close();
});

test("deleteSession removes the session", () => {
  const sqlite = setupDb();
  const sessionId = createSession(sqlite, "user-4");
  deleteSession(sqlite, sessionId);
  expect(getSession(sqlite, sessionId)).toBeNull();
  sqlite.close();
});

test("deleteUserSessions removes all sessions for a user", () => {
  const sqlite = setupDb();
  const s1 = createSession(sqlite, "user-5");
  const s2 = createSession(sqlite, "user-5");
  const s3 = createSession(sqlite, "user-6");

  deleteUserSessions(sqlite, "user-5");

  expect(getSession(sqlite, s1)).toBeNull();
  expect(getSession(sqlite, s2)).toBeNull();
  expect(getSession(sqlite, s3)).not.toBeNull(); // different user unaffected
  sqlite.close();
});

test("cleanupExpiredSessions removes only expired rows", () => {
  const sqlite = setupDb();
  const activeId = createSession(sqlite, "user-7", 3600);

  // Insert an already-expired session directly
  sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: "old-session",
      $userId: "user-7",
      $expiresAt: Math.floor(Date.now() / 1000) - 100,
      $createdAt: new Date().toISOString(),
    });

  cleanupExpiredSessions(sqlite);

  // Active session should still be there (via direct query to avoid the getSession expiry check)
  const active = sqlite
    .query<{ id: string }, { $id: string }>(
      "SELECT id FROM _sessions WHERE id = $id",
    )
    .get({ $id: activeId });
  expect(active).not.toBeNull();

  // Expired session should be gone
  const expired = sqlite
    .query<{ id: string }, { $id: string }>(
      "SELECT id FROM _sessions WHERE id = $id",
    )
    .get({ $id: "old-session" });
  expect(expired).toBeNull();

  sqlite.close();
});
