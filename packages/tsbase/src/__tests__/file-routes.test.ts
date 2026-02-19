import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createFileRoutes } from "../storage/routes.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull(),
});

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull(),
});

function setupDbAndRoutes(allowView: boolean) {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");

  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL
    );
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL
    );
  `);
  sqlite
    .query(
      "INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $passwordHash, $role)",
    )
    .run({
      $id: "user-1",
      $email: "user@example.com",
      $passwordHash: "hash",
      $role: "user",
    });
  sqlite
    .query("INSERT INTO posts (id, author_id) VALUES ($id, $authorId)")
    .run({ $id: "post-1", $authorId: "user-1" });

  const sessionId = "session-1";
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: sessionId,
      $userId: "user-1",
      $expiresAt: expiresAt,
      $createdAt: new Date().toISOString(),
    });

  const tempRoot = mkdtempSync(join(tmpdir(), "tsbase-file-test-"));
  const storagePath = "posts/post-1/file-1.txt";
  mkdirSync(dirname(join(tempRoot, storagePath)), { recursive: true });
  writeFileSync(join(tempRoot, storagePath), "hello file");
  sqlite
    .query(
      `INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at)
       VALUES ($id, $collection, $recordId, $filename, $mimeType, $size, $storagePath, $createdAt)`,
    )
    .run({
      $id: "file-1",
      $collection: "posts",
      $recordId: "post-1",
      $filename: "file-1.txt",
      $mimeType: "text/plain",
      $size: 10,
      $storagePath: storagePath,
      $createdAt: new Date().toISOString(),
    });

  const routes = createFileRoutes({
    db,
    adapter,
    internalSchema,
    config: makeResolvedConfig({
      storage: {
        driver: "local",
        localPath: tempRoot,
        maxFileSize: 10 * 1024 * 1024,
      },
    }),
    schema: { users: usersTable, posts },
    rules: {
      posts: {
        view: () => allowView,
      },
    },
    usersTable,
  });

  return { sqlite, routes, sessionId, tempRoot };
}

test("file download rejects unauthenticated requests", async () => {
  const { sqlite, routes, tempRoot } = setupDbAndRoutes(true);
  try {
    const response = await routes["/files/:id"].GET(
      new Request("http://localhost/files/file-1"),
    );
    expect(response.status).toBe(401);
  } finally {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("file download enforces collection view rule", async () => {
  const { sqlite, routes, sessionId, tempRoot } = setupDbAndRoutes(false);
  try {
    const response = await routes["/files/:id"].GET(
      new Request("http://localhost/files/file-1", {
        headers: {
          cookie: `tsbase_session=${sessionId}`,
        },
      }),
    );
    expect(response.status).toBe(403);
  } finally {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("file download succeeds when authenticated and allowed", async () => {
  const { sqlite, routes, sessionId, tempRoot } = setupDbAndRoutes(true);
  try {
    const response = await routes["/files/:id"].GET(
      new Request("http://localhost/files/file-1", {
        headers: {
          cookie: `tsbase_session=${sessionId}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello file");
  } finally {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
