import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createServer } from "../core/server.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull(),
});

test("admin file listing requires an authenticated admin user", async () => {
  const root = mkdtempSync(join(tmpdir(), "bunbase-admin-test-"));
  const dbPath = join(root, "db.sqlite");

  const bunbase = createServer({
    schema: { users },
    config: makeResolvedConfig({
      development: true,
      dbPath,
      database: { driver: "sqlite" as const, url: dbPath },
      storage: {
        driver: "local",
        localPath: join(root, "uploads"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle"),
    }),
  });

  await bunbase.adapter.rawExecute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL
    );
  `);

  await bunbase.adapter.rawExecute(
    "INSERT INTO users (id, email, password_hash, role) VALUES ('admin-1', 'admin@example.com', 'hash', 'admin')",
  );
  await bunbase.adapter.rawExecute(
    "INSERT INTO users (id, email, password_hash, role) VALUES ('user-1', 'user@example.com', 'hash', 'user')",
  );

  const now = Math.floor(Date.now() / 1000) + 3600;
  const createdAt = new Date().toISOString();
  await bunbase.adapter.rawExecute(
    `INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ('admin-session', 'admin-1', ${now}, '${createdAt}')`,
  );
  await bunbase.adapter.rawExecute(
    `INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ('user-session', 'user-1', ${now}, '${createdAt}')`,
  );

  await bunbase.adapter.rawExecute(
    `INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at)
     VALUES ('file-1', 'users', 'user-1', 'avatar.png', 'image/png', 123, 'users/user-1/avatar.png', '${createdAt}')`,
  );

  const server = bunbase.listen(0);

  try {
    const unauthenticated = await fetch(`${server.url}_admin/api/files`);
    expect(unauthenticated.status).toBe(401);

    const nonAdmin = await fetch(`${server.url}_admin/api/files`, {
      headers: {
        cookie: "bunbase_session=user-session",
      },
    });
    expect(nonAdmin.status).toBe(403);

    const admin = await fetch(`${server.url}_admin/api/files`, {
      headers: {
        cookie: "bunbase_session=admin-session",
      },
    });
    expect(admin.status).toBe(200);
    const payload = (await admin.json()) as Array<{ id: string }>;
    expect(payload[0]?.id).toBe("file-1");
  } finally {
    server.stop();
    bunbase.adapter.close();
    rmSync(root, { recursive: true, force: true });
  }
});
