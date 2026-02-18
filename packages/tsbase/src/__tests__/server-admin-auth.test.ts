import { test, expect } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../core/server.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull(),
});

test("admin file listing requires an authenticated admin user", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsbase-admin-test-"));

  const tsbase = createServer({
    schema: { users },
    config: makeResolvedConfig({
      development: true,
      dbPath: join(root, "db.sqlite"),
      storage: {
        driver: "local",
        localPath: join(root, "uploads"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle"),
    }),
  });

  tsbase.sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL
    );
  `);

  tsbase.sqlite
    .query(
      "INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $passwordHash, $role)",
    )
    .run({
      $id: "admin-1",
      $email: "admin@example.com",
      $passwordHash: "hash",
      $role: "admin",
    });
  tsbase.sqlite
    .query(
      "INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $passwordHash, $role)",
    )
    .run({
      $id: "user-1",
      $email: "user@example.com",
      $passwordHash: "hash",
      $role: "user",
    });

  const now = Math.floor(Date.now() / 1000) + 3600;
  tsbase.sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: "admin-session",
      $userId: "admin-1",
      $expiresAt: now,
      $createdAt: new Date().toISOString(),
    });
  tsbase.sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: "user-session",
      $userId: "user-1",
      $expiresAt: now,
      $createdAt: new Date().toISOString(),
    });

  tsbase.sqlite
    .query(
      `INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at)
       VALUES ($id, $collection, $recordId, $filename, $mimeType, $size, $storagePath, $createdAt)`,
    )
    .run({
      $id: "file-1",
      $collection: "users",
      $recordId: "user-1",
      $filename: "avatar.png",
      $mimeType: "image/png",
      $size: 123,
      $storagePath: "users/user-1/avatar.png",
      $createdAt: new Date().toISOString(),
    });

  const server = tsbase.listen(0);

  try {
    const unauthenticated = await fetch(`${server.url}_admin/api/files`);
    expect(unauthenticated.status).toBe(401);

    const nonAdmin = await fetch(`${server.url}_admin/api/files`, {
      headers: {
        cookie: "tsbase_session=user-session",
      },
    });
    expect(nonAdmin.status).toBe(403);

    const admin = await fetch(`${server.url}_admin/api/files`, {
      headers: {
        cookie: "tsbase_session=admin-session",
      },
    });
    expect(admin.status).toBe(200);
    const payload = (await admin.json()) as Array<{ id: string }>;
    expect(payload[0]?.id).toBe("file-1");
  } finally {
    server.stop();
    tsbase.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
