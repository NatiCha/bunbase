import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq, getColumns } from "drizzle-orm";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { createFileRoutes, createStorageDriver } from "../storage/routes.ts";
import { createLocalStorage } from "../storage/local.ts";
import { createSession } from "../auth/sessions.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const storageDir = join(tmpdir(), `bunbase-storage-ext-test-${Date.now()}`);
mkdirSync(storageDir, { recursive: true });

afterAll(() => {
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("user"),
});

const postsTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

// A table without an id column — used to exercise the "missing id column" path
const noIdTable = sqliteTable("things", {
  pk: text("pk").primaryKey(),
  label: text("label").notNull(),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user')",
  );
  sqlite.run("CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, adapter, internalSchema };
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

// ─── createStorageDriver — S3 branch (line 35) ────────────────────────────────

test("createStorageDriver returns S3 driver when config uses s3 driver", () => {
  const config = makeResolvedConfig({
    storage: {
      driver: "s3" as const,
      localPath: "./data/uploads",
      s3: {
        bucket: "test-bucket",
        region: "us-east-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
    },
  });
  const driver = createStorageDriver(config);
  expect(typeof driver.write).toBe("function");
  expect(typeof driver.read).toBe("function");
  expect(typeof driver.delete).toBe("function");
  expect(typeof driver.exists).toBe("function");
});

// ─── POST /files — missing params (line 122) ─────────────────────────────────

test("POST /files returns 400 when collection param is missing from URL", async () => {
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

  const formData = new FormData();
  formData.append("file", new File(["data"], "f.txt", { type: "text/plain" }));

  // URL without collection or recordId — pathParts[2] will be ""
  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

// ─── POST /files — create rule denied (line 129) ─────────────────────────────

test("POST /files returns 403 when create rule denies access", async () => {
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
    rules: { posts: { create: () => false } },
    usersTable,
  });

  const formData = new FormData();
  formData.append("file", new File(["data"], "f.txt", { type: "text/plain" }));

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-1", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(403);
  sqlite.close();
});

test("POST /files passes method/headers/query/db in rule arg", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-arg", $title: "Post Arg" });

  let capturedArg: any = null;
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: {
      posts: {
        create: (arg) => {
          capturedArg = arg;
          return null;
        },
      },
    },
    usersTable,
  });

  const formData = new FormData();
  formData.append("file", new File(["data"], "f.txt", { type: "text/plain" }));

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-arg?source=test-suite", {
      method: "POST",
      headers: {
        cookie: `bunbase_session=${sessionId}`,
        "X-Trace-Id": "trace-123",
      },
      body: formData,
    }),
  );

  expect(response.status).toBe(201);
  expect(capturedArg).not.toBeNull();
  expect(capturedArg.method).toBe("POST");
  expect(capturedArg.headers["x-trace-id"]).toBe("trace-123");
  expect(capturedArg.query.source).toBe("test-suite");
  expect(capturedArg.body).toEqual({});
  expect(capturedArg.db).toBe(db);
  sqlite.close();
});

// ─── POST /files — unknown collection in SQLite (line 143) ───────────────────

test("POST /files returns 404 when collection table does not exist in SQLite", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  await createUser(sqlite, db, internalSchema);

  // Schema has "posts" but SQLite table was never created (different db)
  const sqlite2 = new Database(":memory:");
  const adapter2 = new SqliteAdapter(sqlite2);
  adapter2.bootstrapInternalTables();
  sqlite2.run(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user')",
  );
  // Note: no "CREATE TABLE posts" here
  const db2 = drizzle({ client: sqlite2 });
  const internalSchema2 = getInternalSchema("sqlite");
  sqlite2
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "u2", $email: "u2@example.com", $role: "user" });
  const sessionId2 = await createSession(db2, internalSchema2, "u2");

  const routes = createFileRoutes({
    db: db2,
    adapter: adapter2,
    internalSchema: internalSchema2,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { create: () => null } },
    usersTable,
  });

  const formData = new FormData();
  formData.append("file", new File(["data"], "f.txt", { type: "text/plain" }));

  const response = await routes["/files/:collection/:recordId"].POST(
    new Request("http://localhost/files/posts/rec-1", {
      method: "POST",
      headers: { cookie: `bunbase_session=${sessionId2}` },
      body: formData,
    }),
  );
  expect(response.status).toBe(404);
  sqlite.close();
  sqlite2.close();
});

// ─── GET /files — missing fileId (line 222) ───────────────────────────────────

test("GET /files returns 400 when file ID is missing from URL", async () => {
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

  // Trailing slash means pathParts[2] = ""
  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/", {
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

// ─── GET /files — collection not found (line 65) ─────────────────────────────

test("GET /files returns 404 when file's collection is not in schema", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);

  // Insert a file record for an "orphaned" collection not in schema
  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "orphan-file",
      $col: "orphaned",
      $recId: "rec-x",
      $fn: "file.txt",
      $mt: "text/plain",
      $sz: 4,
      $sp: "orphaned/rec-x/orphan-file.txt",
      $ca: new Date().toISOString(),
    });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    // schema only has "posts", not "orphaned"
    schema: { posts: postsTable },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/orphan-file", {
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(404);
  sqlite.close();
});

// ─── GET /files — missing id column (lines 71-75) ────────────────────────────

test("GET /files returns 500 when collection table has no id column", async () => {
  const sqlite2 = new Database(":memory:");
  const adapter2 = new SqliteAdapter(sqlite2);
  adapter2.bootstrapInternalTables();
  sqlite2.run(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user')",
  );
  // things table uses pk, not id
  sqlite2.run("CREATE TABLE things (pk TEXT PRIMARY KEY, label TEXT NOT NULL)");
  const db2 = drizzle({ client: sqlite2 });
  const internalSchema2 = getInternalSchema("sqlite");

  sqlite2
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "u3", $email: "u3@example.com", $role: "user" });
  const sessionId = await createSession(db2, internalSchema2, "u3");

  // Insert a file record for "things" collection
  sqlite2
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "no-id-file",
      $col: "things",
      $recId: "thing-1",
      $fn: "file.txt",
      $mt: "text/plain",
      $sz: 4,
      $sp: "things/thing-1/no-id-file.txt",
      $ca: new Date().toISOString(),
    });

  const routes = createFileRoutes({
    db: db2,
    adapter: adapter2,
    internalSchema: internalSchema2,
    config: makeConfig(),
    schema: { things: noIdTable as any },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/no-id-file", {
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(500);
  sqlite2.close();
});

// ─── GET /files — storage.read returns null (line 255) ───────────────────────

test("GET /files returns 404 when file data is missing from storage", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post" });

  // Insert file record but do NOT write the actual file to storage
  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "ghost-file",
      $col: "posts",
      $recId: "rec-1",
      $fn: "ghost.txt",
      $mt: "text/plain",
      $sz: 10,
      $sp: "posts/rec-1/ghost-file.txt",
      $ca: new Date().toISOString(),
    });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { get: () => null } },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/ghost-file", {
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(404);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("data not found");
  sqlite.close();
});

// ─── GET /files — success path ───────────────────────────────────────────────

test("GET /files returns file content when authenticated and file exists", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post" });

  const fileContent = new TextEncoder().encode("Hello, file!");
  const storagePath = "posts/rec-1/my-file.txt";
  await createLocalStorage(storageDir).write(storagePath, fileContent);

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "real-file",
      $col: "posts",
      $recId: "rec-1",
      $fn: "my-file.txt",
      $mt: "text/plain",
      $sz: fileContent.length,
      $sp: storagePath,
      $ca: new Date().toISOString(),
    });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { get: () => null } },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/real-file", {
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/plain");
  sqlite.close();
});

test("GET /files passes method/headers/query/id/db in read rule arg", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-get-arg", $title: "Post" });

  const storagePath = "posts/rec-get-arg/get-arg-file.txt";
  const storage = createLocalStorage(storageDir);
  await storage.write(storagePath, new TextEncoder().encode("hello"));

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "get-arg-file",
      $col: "posts",
      $recId: "rec-get-arg",
      $fn: "get-arg-file.txt",
      $mt: "text/plain",
      $sz: 5,
      $sp: storagePath,
      $ca: new Date().toISOString(),
    });

  let capturedArg: any = null;
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: {
      posts: {
        get: (arg) => {
          capturedArg = arg;
          return null;
        },
      },
    },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/get-arg-file?download=1", {
      headers: {
        cookie: `bunbase_session=${sessionId}`,
        "X-Client": "web",
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(capturedArg).not.toBeNull();
  expect(capturedArg.id).toBe("rec-get-arg");
  expect(capturedArg.method).toBe("GET");
  expect(capturedArg.headers["x-client"]).toBe("web");
  expect(capturedArg.query.download).toBe("1");
  expect(capturedArg.body).toEqual({});
  expect(capturedArg.db).toBe(db);
  sqlite.close();
});

// ─── DELETE /files — missing fileId (line 278) ───────────────────────────────

test("DELETE /files returns 400 when file ID is missing from URL", async () => {
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
    new Request("http://localhost/files/", {
      method: "DELETE",
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

// ─── DELETE /files — delete rule denied (lines 300-309) ──────────────────────

test("DELETE /files returns 403 when delete rule denies access", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post" });

  const storagePath = "posts/rec-1/deny-file.txt";
  await createLocalStorage(storageDir).write(storagePath, new Uint8Array([1]));

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "deny-file",
      $col: "posts",
      $recId: "rec-1",
      $fn: "deny-file.txt",
      $mt: "text/plain",
      $sz: 1,
      $sp: storagePath,
      $ca: new Date().toISOString(),
    });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { delete: () => false } },
    usersTable,
  });

  const response = await routes["/files/:id"].DELETE(
    new Request("http://localhost/files/deny-file", {
      method: "DELETE",
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(403);
  sqlite.close();
});

// ─── DELETE /files — success path (lines 311-314) ────────────────────────────

test("DELETE /files successfully removes file and DB record", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-1", $title: "Post" });

  const storage = createLocalStorage(storageDir);
  const storagePath = "posts/rec-1/del-file.txt";
  await storage.write(storagePath, new TextEncoder().encode("bye"));

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "del-file",
      $col: "posts",
      $recId: "rec-1",
      $fn: "del-file.txt",
      $mt: "text/plain",
      $sz: 3,
      $sp: storagePath,
      $ca: new Date().toISOString(),
    });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: { posts: { delete: () => null } },
    usersTable,
  });

  const response = await routes["/files/:id"].DELETE(
    new Request("http://localhost/files/del-file", {
      method: "DELETE",
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json() as { deleted: boolean };
  expect(body.deleted).toBe(true);

  const row = sqlite
    .query<{ id: string }, { $id: string }>(
      "SELECT id FROM _files WHERE id = $id",
    )
    .get({ $id: "del-file" });
  expect(row).toBeNull();
  expect(await storage.exists(storagePath)).toBe(false);
  sqlite.close();
});

test("DELETE /files passes method/headers/query/id/db in delete rule arg", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "rec-del-arg", $title: "Post" });

  const storagePath = "posts/rec-del-arg/del-arg-file.txt";
  await createLocalStorage(storageDir).write(storagePath, new Uint8Array([1]));

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "del-arg-file",
      $col: "posts",
      $recId: "rec-del-arg",
      $fn: "del-arg-file.txt",
      $mt: "text/plain",
      $sz: 1,
      $sp: storagePath,
      $ca: new Date().toISOString(),
    });

  let capturedArg: any = null;
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: {
      posts: {
        delete: (arg) => {
          capturedArg = arg;
          return null;
        },
      },
    },
    usersTable,
  });

  const response = await routes["/files/:id"].DELETE(
    new Request("http://localhost/files/del-arg-file?cascade=1", {
      method: "DELETE",
      headers: {
        cookie: `bunbase_session=${sessionId}`,
        "X-Delete-Reason": "cleanup",
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(capturedArg).not.toBeNull();
  expect(capturedArg.id).toBe("rec-del-arg");
  expect(capturedArg.method).toBe("DELETE");
  expect(capturedArg.headers["x-delete-reason"]).toBe("cleanup");
  expect(capturedArg.query.cascade).toBe("1");
  expect(capturedArg.body).toEqual({});
  expect(capturedArg.db).toBe(db);
  sqlite.close();
});

// ─── GET /files — whereClause rule path (lines 89-101) ───────────────────────

test("GET /files returns 403 when whereClause rule filters out the record", async () => {
  const { sqlite, db, adapter, internalSchema } = setupDb();
  const sessionId = await createUser(sqlite, db, internalSchema);
  sqlite
    .query("INSERT INTO posts (id, title) VALUES ($id, $title)")
    .run({ $id: "other-rec", $title: "Other" });

  const storagePath = "posts/other-rec/wc-file.txt";
  await createLocalStorage(storageDir).write(storagePath, new Uint8Array([1]));

  sqlite
    .query(
      "INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at) VALUES ($id, $col, $recId, $fn, $mt, $sz, $sp, $ca)",
    )
    .run({
      $id: "wc-file",
      $col: "posts",
      $recId: "other-rec",
      $fn: "wc-file.txt",
      $mt: "text/plain",
      $sz: 1,
      $sp: storagePath,
      $ca: new Date().toISOString(),
    });

  // Rule: view is only allowed when id === "allowed-rec" (not "other-rec")
  const cols = getColumns(postsTable);
  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeConfig(),
    schema: { posts: postsTable },
    rules: {
      posts: {
        get: () => eq(cols.id, "allowed-rec"),
      },
    },
    usersTable,
  });

  const response = await routes["/files/:id"].GET(
    new Request("http://localhost/files/wc-file", {
      headers: { cookie: `bunbase_session=${sessionId}` },
    }),
  );
  expect(response.status).toBe(403);
  sqlite.close();
});
