import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import {
  handleAdminApi,
  pushRequestLog,
} from "../admin/routes.ts";
import { createLocalStorage } from "../storage/local.ts";
import { createSession } from "../auth/sessions.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const storageDir = join(tmpdir(), `tsbase-admin-test-${Date.now()}`);
mkdirSync(storageDir, { recursive: true });

afterAll(() => {
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

const postsTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user')",
  );
  sqlite.run(
    "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
  );
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, adapter, internalSchema };
}

async function createAdmin(sqlite: Database, db: any, internalSchema: any): Promise<string> {
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "admin-1", $email: "admin@example.com", $role: "admin" });
  return createSession(db, internalSchema, "admin-1");
}

function adminReq(path: string, sessionId: string, options: RequestInit = {}): Request {
  return new Request(`http://localhost/_admin/api${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      cookie: `tsbase_session=${sessionId}`,
    },
  });
}

const config = makeResolvedConfig({ development: true });
const storage = createLocalStorage(storageDir);
const schema = { posts: postsTable, users: usersTable };

// ─── pushRequestLog ───────────────────────────────────────────────────────────

test("pushRequestLog inserts a log entry", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  await pushRequestLog(db, internalSchema, {
    id: "log-1",
    method: "GET",
    path: "/api/test",
    status: 200,
    durationMs: 42,
    userId: null,
    timestamp: new Date().toISOString(),
  });

  const row = sqlite
    .query<{ method: string; path: string }, { $id: string }>(
      "SELECT method, path FROM _request_logs WHERE id = $id",
    )
    .get({ $id: "log-1" });

  expect(row?.method).toBe("GET");
  expect(row?.path).toBe("/api/test");
  sqlite.close();
});

test("pushRequestLog trims to 500 most recent entries", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  // Insert 505 entries — oldest should be trimmed
  for (let i = 1; i <= 505; i++) {
    await pushRequestLog(db, internalSchema, {
      id: `log-${i}`,
      method: "GET",
      path: `/path/${i}`,
      status: 200,
      durationMs: 1,
      userId: null,
      timestamp: new Date(Date.now() + i).toISOString(),
    });
  }

  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _request_logs")
    .get([]);
  expect(count?.n).toBeLessThanOrEqual(500);
  sqlite.close();
});

// ─── handleAdminApi — auth checks ─────────────────────────────────────────────

test("handleAdminApi returns 401 when not authenticated", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const response = await handleAdminApi(
    new Request("http://localhost/_admin/api/users"),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

test("handleAdminApi returns 403 when user is not an admin", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "u1", $email: "user@example.com", $role: "user" });
  const sessionId = await createSession(db, internalSchema, "u1");

  const response = await handleAdminApi(
    adminReq("/users", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(403);
  sqlite.close();
});

// ─── handleAdminApi — endpoints ───────────────────────────────────────────────

test("GET /users returns a list of users (password stripped)", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/users", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const users = await response.json() as Array<{ role: string; password_hash?: string }>;
  expect(Array.isArray(users)).toBe(true);
  expect(users.some((u) => u.role === "admin")).toBe(true);
  expect(users.every((u) => !("password_hash" in u))).toBe(true);
});

test("GET /sessions returns all sessions", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/sessions", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const sessions = await response.json() as Array<{ id: string }>;
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions.some((s) => s.id === sessionId)).toBe(true);
});

test("DELETE /sessions/:id removes a session", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const adminSession = await createAdmin(sqlite, db, internalSchema);
  // Create an extra session to delete
  const extra = await createSession(db, internalSchema, "admin-1");

  const response = await handleAdminApi(
    adminReq(`/sessions/${extra}`, adminSession, { method: "DELETE" }),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as { deleted: boolean };
  expect(body.deleted).toBe(true);

  const row = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM _sessions WHERE id = $id")
    .get({ $id: extra });
  expect(row).toBeNull();
  sqlite.close();
});

test("GET /logs returns request logs", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);
  await pushRequestLog(db, internalSchema, {
    id: "req-1",
    method: "POST",
    path: "/auth/login",
    status: 200,
    durationMs: 20,
    userId: null,
    timestamp: new Date().toISOString(),
  });

  const response = await handleAdminApi(
    adminReq("/logs", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const logs = await response.json() as Array<{ method: string }>;
  expect(Array.isArray(logs)).toBe(true);
  expect(logs.some((l) => l.method === "POST")).toBe(true);
});

test("DELETE /logs clears all request logs", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);
  await pushRequestLog(db, internalSchema, {
    id: "req-clear",
    method: "GET",
    path: "/",
    status: 200,
    durationMs: 5,
    userId: null,
    timestamp: new Date().toISOString(),
  });

  const response = await handleAdminApi(
    adminReq("/logs", sessionId, { method: "DELETE" }),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as { cleared: boolean };
  expect(body.cleared).toBe(true);

  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _request_logs")
    .get([]);
  expect(count?.n).toBe(0);
  sqlite.close();
});

test("GET /config returns sanitized configuration", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/config", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as {
    development: boolean;
    database: { driver: string };
    auth: { tokenExpiry: number };
  };
  expect(body.development).toBe(true);
  expect(typeof body.database.driver).toBe("string");
  expect(typeof body.auth.tokenExpiry).toBe("number");
});

test("GET /schema returns table column definitions", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/schema", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, Array<{ key: string }>>;
  expect(Array.isArray(body.posts)).toBe(true);
  expect(body.posts.some((col) => col.key === "id")).toBe(true);
});

test("GET /tables returns table names and record counts", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "p1", $title: "Hello" });

  const response = await handleAdminApi(
    adminReq("/tables", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as Array<{ name: string; count: number }>;
  const postsEntry = body.find((t) => t.name === "posts");
  expect(postsEntry?.count).toBe(1);
});

test("GET /files returns all file records", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/files", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const files = await response.json() as unknown[];
  expect(Array.isArray(files)).toBe(true);
});

test("GET /oauth returns all oauth accounts", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/oauth", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
  const accounts = await response.json() as unknown[];
  expect(Array.isArray(accounts)).toBe(true);
});

test("GET /records/:table returns paginated rows", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "p1", $title: "Hello" });

  const response = await handleAdminApi(
    adminReq("/records/posts", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(200);
});

test("GET /records/:table returns 404 for unknown table", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/records/nonexistent", sessionId),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

test("DELETE /files/:id returns 404 when file not found", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createAdmin(sqlite, db, internalSchema);

  const response = await handleAdminApi(
    adminReq("/files/no-such-file", sessionId, { method: "DELETE" }),
    db,
    adapter,
    internalSchema,
    config,
    schema,
    storage,
    usersTable,
  );
  expect(response.status).toBe(404);
  sqlite.close();
});
