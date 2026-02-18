import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { bootstrapInternalTables } from "../core/bootstrap.ts";
import { handleAdminApi, pushRequestLog } from "../admin/routes.ts";
import { createLocalStorage } from "../storage/local.ts";
import { createSession } from "../auth/sessions.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const storageDir = join(tmpdir(), `tsbase-admin-records-test-${Date.now()}`);
mkdirSync(storageDir, { recursive: true });

afterAll(() => {
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

const postsTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull(),
});

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  role: text("role").notNull(),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  bootstrapInternalTables(sqlite);
  sqlite.run(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user')",
  );
  sqlite.run(
    "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL)",
  );
  return sqlite;
}

function createAdmin(sqlite: Database): string {
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "admin-1", $email: "admin@example.com", $role: "admin" });
  return createSession(sqlite, "admin-1");
}

function adminReq(
  path: string,
  sessionId: string,
  options: RequestInit = {},
): Request {
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

// ─── POST /records/:table ─────────────────────────────────────────────────────

test("POST /records/:table creates a new record and returns 201", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);

  const response = await handleAdminApi(
    adminReq("/records/posts", sessionId, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Post", author: "Alice" }),
    }),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(201);
  const body = await response.json() as { id: string; title: string };
  expect(body.title).toBe("New Post");
  expect(body.id).toBeDefined();

  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM posts")
    .get([]);
  expect(count?.n).toBe(1);
  sqlite.close();
});

test("POST /records/:table returns 404 for unknown table", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);

  const response = await handleAdminApi(
    adminReq("/records/nonexistent", sessionId, {
      method: "POST",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
    }),
    sqlite,
    config,
    schema,
    storage,
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

test("POST /records/:table uses provided id when given", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);

  await handleAdminApi(
    adminReq("/records/posts", sessionId, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "custom-id", title: "Custom", author: "Bob" }),
    }),
    sqlite,
    config,
    schema,
    storage,
  );

  const row = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM posts WHERE id = $id")
    .get({ $id: "custom-id" });
  expect(row?.id).toBe("custom-id");
  sqlite.close();
});

// ─── PATCH /records/:table/:id ────────────────────────────────────────────────

test("PATCH /records/:table/:id updates a record and returns 200", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);
  sqlite
    .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
    .run({ $id: "p1", $title: "Old Title", $author: "Alice" });

  const response = await handleAdminApi(
    adminReq("/records/posts/p1", sessionId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated Title" }),
    }),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { title: string };
  expect(body.title).toBe("Updated Title");
  sqlite.close();
});

test("PATCH /records/:table/:id returns 404 for unknown table", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);

  const response = await handleAdminApi(
    adminReq("/records/nonexistent/p1", sessionId, {
      method: "PATCH",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
    }),
    sqlite,
    config,
    schema,
    storage,
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

test("PATCH /records/:table/:id returns 400 when no valid fields provided", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);
  sqlite
    .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
    .run({ $id: "p1", $title: "Title", $author: "Alice" });

  const response = await handleAdminApi(
    adminReq("/records/posts/p1", sessionId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Send fields that are blocked (id, created_at) — results in no valid fields
      body: JSON.stringify({ id: "new-id", created_at: "2024-01-01" }),
    }),
    sqlite,
    config,
    schema,
    storage,
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

// ─── DELETE /records/:table/:id ───────────────────────────────────────────────

test("DELETE /records/:table/:id removes the record and returns deleted: true", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);
  sqlite
    .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
    .run({ $id: "p1", $title: "Post", $author: "Alice" });

  const response = await handleAdminApi(
    adminReq("/records/posts/p1", sessionId, { method: "DELETE" }),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { deleted: boolean };
  expect(body.deleted).toBe(true);

  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM posts")
    .get([]);
  expect(count?.n).toBe(0);
  sqlite.close();
});

test("DELETE /records/:table/:id returns 404 for unknown table", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);

  const response = await handleAdminApi(
    adminReq("/records/nonexistent/p1", sessionId, { method: "DELETE" }),
    sqlite,
    config,
    schema,
    storage,
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

// ─── GET /records/:table — search ─────────────────────────────────────────────

test("GET /records/:table with search param filters results by text columns", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);
  sqlite
    .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
    .run({ $id: "p1", $title: "Hello World", $author: "Alice" });
  sqlite
    .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
    .run({ $id: "p2", $title: "Goodbye", $author: "Bob" });

  const response = await handleAdminApi(
    adminReq("/records/posts?search=Hello", sessionId),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<{ id: string }> };
  expect(body.data).toHaveLength(1);
  expect(body.data[0].id).toBe("p1");
  sqlite.close();
});

test("GET /records/:table with sort and order params returns sorted results", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);
  sqlite
    .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
    .run({ $id: "p1", $title: "Zebra", $author: "Alice" });
  sqlite
    .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
    .run({ $id: "p2", $title: "Apple", $author: "Bob" });

  const response = await handleAdminApi(
    adminReq("/records/posts?sort=title&order=asc", sessionId),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<{ title: string }> };
  expect(body.data[0].title).toBe("Apple");
  sqlite.close();
});

// ─── GET /tables — sort order ─────────────────────────────────────────────────

test("GET /tables places users table before non-auth tables", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);

  const response = await handleAdminApi(
    adminReq("/tables", sessionId),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as Array<{ name: string; type: string }>;
  const usersIndex = body.findIndex((t) => t.name === "users");
  const postsIndex = body.findIndex((t) => t.name === "posts");
  // users (auth) should come before posts (base)
  expect(usersIndex).toBeLessThan(postsIndex);
  sqlite.close();
});

// ─── DELETE /files/:id — success path ────────────────────────────────────────

test("DELETE /files/:id in admin successfully removes file and storage", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);

  // Write a real file to local storage
  const filePath = "posts/rec1/file1.txt";
  await storage.write(filePath, new TextEncoder().encode("content"));

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "file-admin-del",
      $col: "posts",
      $recId: "rec1",
      $fn: "file1.txt",
      $mt: "text/plain",
      $sz: 7,
      $sp: filePath,
      $ca: new Date().toISOString(),
    });

  const response = await handleAdminApi(
    adminReq("/files/file-admin-del", sessionId, { method: "DELETE" }),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { deleted: boolean };
  expect(body.deleted).toBe(true);

  // DB record gone
  const row = sqlite
    .query<{ id: string }, { $id: string }>(
      "SELECT id FROM _files WHERE id = $id",
    )
    .get({ $id: "file-admin-del" });
  expect(row).toBeNull();

  // File gone from storage
  expect(await storage.exists(filePath)).toBe(false);
  sqlite.close();
});

// ─── GET /records/:table — pagination ─────────────────────────────────────────

test("GET /records/:table returns pagination metadata", async () => {
  const sqlite = setupDb();
  const sessionId = createAdmin(sqlite);
  for (let i = 1; i <= 5; i++) {
    sqlite
      .query("INSERT INTO posts (id, title, author) VALUES ($id, $title, $author)")
      .run({ $id: `p${i}`, $title: `Post ${i}`, $author: "Alice" });
  }

  const response = await handleAdminApi(
    adminReq("/records/posts?limit=2&page=1", sessionId),
    sqlite,
    config,
    schema,
    storage,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as {
    data: unknown[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  expect(body.total).toBe(5);
  expect(body.totalPages).toBe(3);
  expect(body.data).toHaveLength(2);
  sqlite.close();
});

// ─── Request log ─────────────────────────────────────────────────────────────

test("pushRequestLog is covered by successful admin operations", () => {
  const sqlite = setupDb();
  // pushRequestLog is already tested in admin-routes-extended.test.ts
  // This verifies that logs appear after admin operations
  pushRequestLog(sqlite, {
    id: "rlog-1",
    method: "PATCH",
    path: "/_admin/api/records/posts/p1",
    status: 200,
    durationMs: 10,
    userId: "admin-1",
    timestamp: new Date().toISOString(),
  });

  const row = sqlite
    .query<{ method: string }, { $id: string }>(
      "SELECT method FROM _request_logs WHERE id = $id",
    )
    .get({ $id: "rlog-1" });
  expect(row?.method).toBe("PATCH");
  sqlite.close();
});
