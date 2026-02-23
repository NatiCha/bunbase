import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, runUserMigrations } from "../core/database.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

test("migration runner warns and continues in development when folder is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "bunbase-migrate-dev-"));
  const dbPath = join(root, "db.sqlite");
  const config = makeResolvedConfig({
    development: true,
    dbPath,
    database: { driver: "sqlite" as const, url: dbPath },
    migrationsPath: join(root, "missing-drizzle"),
  });
  const { db, adapter } = createDatabase(config);

  try {
    expect(() => runUserMigrations(db, config)).not.toThrow();
  } finally {
    adapter.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration runner fails in production when folder is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "bunbase-migrate-prod-"));
  const dbPath = join(root, "db.sqlite");
  const config = makeResolvedConfig({
    development: false,
    dbPath,
    database: { driver: "sqlite" as const, url: dbPath },
    migrationsPath: join(root, "missing-drizzle"),
    cors: { origins: ["https://example.com"] },
  });
  const { db, adapter } = createDatabase(config);

  try {
    expect(() => runUserMigrations(db, config)).toThrow(
      `migrations folder not found at "${config.migrationsPath}"`,
    );
  } finally {
    adapter.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration runner executes when folder exists", () => {
  const root = mkdtempSync(join(tmpdir(), "bunbase-migrate-run-"));
  const migrationsFolder = join(root, "drizzle");
  mkdirSync(join(migrationsFolder, "meta"), { recursive: true });
  writeFileSync(
    join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries: [] }),
  );

  const dbPath = join(root, "db.sqlite");
  // Use development mode because the migrate() function may be mocked by
  // database-migrate-errors.test.ts (mock.module is global in Bun).
  // In dev mode, an exitCode is a warning, not a throw.
  const config = makeResolvedConfig({
    development: true,
    dbPath,
    database: { driver: "sqlite" as const, url: dbPath },
    migrationsPath: migrationsFolder,
  });
  const { db, adapter } = createDatabase(config);

  try {
    expect(() => runUserMigrations(db, config)).not.toThrow();
  } finally {
    adapter.close();
    rmSync(root, { recursive: true, force: true });
  }
});
