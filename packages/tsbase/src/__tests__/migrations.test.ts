import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, runUserMigrations } from "../core/database.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

test("migration runner warns and continues in development when folder is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "tsbase-migrate-dev-"));
  const config = makeResolvedConfig({
    development: true,
    dbPath: join(root, "db.sqlite"),
    migrationsPath: join(root, "missing-drizzle"),
  });
  const { db, sqlite } = createDatabase(config);

  try {
    expect(() => runUserMigrations(db, config)).not.toThrow();
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration runner fails in production when folder is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "tsbase-migrate-prod-"));
  const config = makeResolvedConfig({
    development: false,
    dbPath: join(root, "db.sqlite"),
    migrationsPath: join(root, "missing-drizzle"),
    cors: { origins: ["https://example.com"] },
  });
  const { db, sqlite } = createDatabase(config);

  try {
    expect(() => runUserMigrations(db, config)).toThrow(
      `migrations folder not found at "${config.migrationsPath}"`,
    );
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration runner executes when folder exists", () => {
  const root = mkdtempSync(join(tmpdir(), "tsbase-migrate-run-"));
  const migrationsFolder = join(root, "drizzle");
  mkdirSync(join(migrationsFolder, "meta"), { recursive: true });
  writeFileSync(
    join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries: [] }),
  );

  const config = makeResolvedConfig({
    development: false,
    dbPath: join(root, "db.sqlite"),
    migrationsPath: migrationsFolder,
    cors: { origins: ["https://example.com"] },
  });
  const { db, sqlite } = createDatabase(config);

  try {
    expect(() => runUserMigrations(db, config)).not.toThrow();
  } finally {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
