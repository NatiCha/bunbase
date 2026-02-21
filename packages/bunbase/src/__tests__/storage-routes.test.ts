import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { createFileRoutes, deleteRecordFiles, createStorageDriver } from "../storage/routes.ts";
import { createLocalStorage } from "../storage/local.ts";
import { createSession } from "../auth/sessions.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const storageDir = join(tmpdir(), `bunbase-storage-routes-test-${Date.now()}`);
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
  sqlite.run("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user')");
  sqlite.run("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, adapter, internalSchema };
}

async function createAdminUser(sqlite: Database, db: any, internalSchema: any): Promise<string> {
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "admin-1", $email: "admin@example.com", $role: "admin" });
  return createSession(db, internalSchema, "admin-1");
}

async function createUser(sqlite: Database, db: any, internalSchema: any): Promise<string> {
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "user-1", $email: "user@example.com", $role: "user" });
  return createSession(db, internalSchema, "user-1");
}

function makeConfig(overrides = {}) {
  return makeResolvedConfig({
    development: true,
    storage: { driver: "local" as const, localPath: storageDir },
    ...overrides,
  });
}

// ─── createStorageDriver ─────────────────────────────────────────────────────

test("createStorageDriver returns local driver for local config", () => {
  const config = makeConfig();
  const driver = createStorageDriver(config);
  expect(typeof driver.write).toBe("function");
  expect(typeof driver.read).toBe("function");
});

// ─── POST /files/:collection/:recordId ───────────────────────────────────────

test("POST /files: returns 401 when not authenticated", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    usersTable,
  });

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-1", { method: "POST" }),
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

test("POST /files: returns 404 when record does not exist", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { create: () => null } },
    usersTable,
  });

  const formData = new FormData();
  formData.append("file", new File(["content"], "test.txt", { type: "text/plain" }));

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/no-such-record", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

test("POST /files: returns 400 when no file is provided", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post 1" });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { create: () => null } },
    usersTable,
  });

  const formData = new FormData();
  // No file appended

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-1", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("POST /files: returns 400 when file exceeds maxFileSize", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post 1" });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeResolvedConfig({
      development: true,
      storage: { driver: "local" as const, localPath: storageDir, maxFileSize: 5 }, // 5 bytes max
    }),
    schema: { posts: postsTable },
    rules: { posts: { create: () => null } },
    usersTable,
  });

  const formData = new FormData();
  formData.append("file", new File(["hello world"], "test.txt", { type: "text/plain" }));

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-1", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("large");
  sqlite.close();
});

test("POST /files: returns 400 when MIME type is not allowed", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post 1" });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeResolvedConfig({
      development: true,
      storage: {
        driver: "local" as const,
        localPath: storageDir,
        allowedMimeTypes: ["image/png"],
      },
    }),
    schema: { posts: postsTable },
    rules: { posts: { create: () => null } },
    usersTable,
  });

  const formData = new FormData();
  formData.append("file", new File(["hello"], "test.txt", { type: "text/plain" }));

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-1", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("POST /files: successfully uploads a file and returns 201", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post 1" });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { create: () => null } },
    usersTable,
  });

  const content = "Hello, file content!";
  const formData = new FormData();
  formData.append("file", new File([content], "hello.txt", { type: "text/plain" }));

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-1", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(201);
  const body = await response.json() as { file: { id: string; filename: string } };
  expect(body.file.filename).toBe("hello.txt");
  expect(body.file.id).toBeDefined();

  // Verify the DB record was created
  const fileRec = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM _files WHERE id = $id")
    .get({ $id: body.file.id });
  expect(fileRec).not.toBeNull();

  sqlite.close();
});

// ─── GET /files/:id ──────────────────────────────────────────────────────────

test("GET /files: returns 401 when not authenticated", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/some-file-id"),
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

test("GET /files: returns 404 for unknown file id", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/no-such-file", {
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

// ─── DELETE /files/:id ───────────────────────────────────────────────────────

test("DELETE /files: returns 401 when not authenticated", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    usersTable,
  });

  const response = await routes["/files/:id"].DELETE(
    new Request("http://localhost/files/some-id"),
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

test("DELETE /files: returns 404 for unknown file id", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    usersTable,
  });

  const response = await routes["/files/:id"].DELETE(
    new Request("http://localhost/files/no-such-file", {
      method: "DELETE",
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

// ─── deleteRecordFiles ───────────────────────────────────────────────────────

test("deleteRecordFiles removes all files for a record", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const storage = createLocalStorage(storageDir);

  // Write a file to storage and insert a DB record
  const path = "posts/rec-del/file1.txt";
  await storage.write(path, new TextEncoder().encode("content"));

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "file-1",
      $col: "posts",
      $recId: "rec-del",
      $fn: "file1.txt",
      $mt: "text/plain",
      $sz: 7,
      $sp: path,
      $ca: new Date().toISOString(),
    });

  await deleteRecordFiles(db, internalSchema, storage, "posts", "rec-del");

  // The DB record and the actual file should be gone
  const remaining = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _files WHERE record_id = 'rec-del'")
    .get([]);
  expect(remaining?.n).toBe(0);
  expect(await storage.exists(path)).toBe(false);

  sqlite.close();
});
