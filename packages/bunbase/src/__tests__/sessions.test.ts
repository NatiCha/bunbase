import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  cleanupExpiredSessions,
  createSession,
  deleteSession,
  deleteUserSessions,
  getSession,
} from "../auth/sessions.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";

function setupDb() {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, internalSchema };
}

test("createSession returns a non-empty session id", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const id = await createSession(db, internalSchema, "user-1");
  expect(typeof id).toBe("string");
  expect(id.length).toBeGreaterThan(0);
  sqlite.close();
});

test("getSession retrieves a freshly created session", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const sessionId = await createSession(db, internalSchema, "user-2");
  const session = await getSession(db, internalSchema, sessionId);
  expect(session).not.toBeNull();
  expect(session?.user_id).toBe("user-2");
  sqlite.close();
});

test("getSession returns null for unknown session id", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const session = await getSession(db, internalSchema, "nonexistent-id");
  expect(session).toBeNull();
  sqlite.close();
});

test("getSession returns null and removes expired session", async () => {
  const { sqlite, db, internalSchema } = setupDb();
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

  const session = await getSession(db, internalSchema, id);
  expect(session).toBeNull();

  // Confirm the expired row was deleted
  const row = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM _sessions WHERE id = $id")
    .get({ $id: id });
  expect(row).toBeNull();

  sqlite.close();
});

test("deleteSession removes the session", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const sessionId = await createSession(db, internalSchema, "user-4");
  await deleteSession(db, internalSchema, sessionId);
  expect(await getSession(db, internalSchema, sessionId)).toBeNull();
  sqlite.close();
});

test("deleteUserSessions removes all sessions for a user", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const s1 = await createSession(db, internalSchema, "user-5");
  const s2 = await createSession(db, internalSchema, "user-5");
  const s3 = await createSession(db, internalSchema, "user-6");

  await deleteUserSessions(db, internalSchema, "user-5");

  expect(await getSession(db, internalSchema, s1)).toBeNull();
  expect(await getSession(db, internalSchema, s2)).toBeNull();
  expect(await getSession(db, internalSchema, s3)).not.toBeNull(); // different user unaffected
  sqlite.close();
});

test("cleanupExpiredSessions removes only expired rows", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const activeId = await createSession(db, internalSchema, "user-7", 3600);

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

  await cleanupExpiredSessions(db, internalSchema);

  // Active session should still be there (via direct query to avoid the getSession expiry check)
  const active = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM _sessions WHERE id = $id")
    .get({ $id: activeId });
  expect(active).not.toBeNull();

  // Expired session should be gone
  const expired = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM _sessions WHERE id = $id")
    .get({ $id: "old-session" });
  expect(expired).toBeNull();

  sqlite.close();
});

test("getSession triggers lazy cleanup after ~100 calls", async () => {
  // Since cleanupCounter is module-level, calling getSession 100+ times guarantees
  // the cleanup branch is exercised regardless of current counter state.
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");

  const sessionId = await createSession(db, internalSchema, "lazy-user", 3600);

  // Insert an expired session to verify cleanup actually runs when triggered
  sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: "old-expired",
      $userId: "lazy-user",
      $expiresAt: Math.floor(Date.now() / 1000) - 1,
      $createdAt: new Date().toISOString(),
    });

  // Call getSession enough times to trigger cleanup (counter resets at 100)
  for (let i = 0; i < 110; i++) {
    await getSession(db, internalSchema, sessionId);
  }

  // The expired session should have been cleaned up by the lazy cleanup
  const expiredAfter = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM _sessions WHERE id = $id")
    .get({ $id: "old-expired" });
  expect(expiredAfter).toBeNull();

  sqlite.close();
});
