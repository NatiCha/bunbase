import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, runUserMigrations } from "../core/database.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const testRoot = join(tmpdir(), `bunbase-db-test-${Date.now()}`);
mkdirSync(testRoot, { recursive: true });

afterAll(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ─── createDatabase ──────────────────────────────────────────────────────────

test("createDatabase creates the SQLite file and returns db+adapter", () => {
  const dbPath = join(testRoot, "new-dir", "test.sqlite");
  const config = makeResolvedConfig({
    database: { driver: "sqlite", url: dbPath },
    dbPath,
  });
  const { db, dialect, adapter } = createDatabase(config);

  expect(existsSync(dbPath)).toBe(true);
  expect(db).toBeDefined();
  expect(dialect).toBe("sqlite");
  expect(adapter).toBeDefined();

  adapter.close();
});

test("createDatabase works when the directory already exists", () => {
  const dir = join(testRoot, "existing-dir");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "second.sqlite");

  const config = makeResolvedConfig({
    database: { driver: "sqlite", url: dbPath },
    dbPath,
  });
  const { adapter } = createDatabase(config);

  expect(existsSync(dbPath)).toBe(true);
  adapter.close();
});

// ─── runUserMigrations ───────────────────────────────────────────────────────

test("runUserMigrations warns and continues in dev when migrations folder is missing", async () => {
  const dbPath = join(testRoot, "migrations-dev.sqlite");
  const migrationsPath = join(testRoot, "no-such-migrations");
  const config = makeResolvedConfig({
    database: { driver: "sqlite", url: dbPath },
    dbPath,
    migrationsPath,
    development: true,
  });
  const { db, adapter } = createDatabase(config);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    // Should not throw in dev mode
    await runUserMigrations(db, config);
    expect(warnings.some((w) => w.includes("migrations folder not found"))).toBe(true);
  } finally {
    console.warn = origWarn;
    adapter.close();
  }
});

// ─── runUserMigrations — catch block ─────────────────────────────────────────
// Create a folder with invalid _journal.json so migrate() throws a parse error.

test("runUserMigrations warns and continues in dev when migrate() throws", async () => {
  const migrationsPath = join(testRoot, "invalid-meta-dev");
  mkdirSync(join(migrationsPath, "meta"), { recursive: true });
  writeFileSync(join(migrationsPath, "meta", "_journal.json"), "{ this is not valid json }");

  const dbPath = join(testRoot, "migrate-catch-dev.sqlite");
  const config = makeResolvedConfig({
    database: { driver: "sqlite", url: dbPath },
    dbPath,
    migrationsPath,
    development: true,
  });
  const { db, adapter } = createDatabase(config);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    await runUserMigrations(db, config);
    expect(warnings.some((w) => w.includes("failed to run migrations"))).toBe(true);
  } finally {
    console.warn = origWarn;
    adapter.close();
  }
});

test("runUserMigrations re-throws in production when migrate() throws", async () => {
  const migrationsPath = join(testRoot, "invalid-meta-prod");
  mkdirSync(join(migrationsPath, "meta"), { recursive: true });
  writeFileSync(join(migrationsPath, "meta", "_journal.json"), "{ not json }");

  const dbPath = join(testRoot, "migrate-catch-prod.sqlite");
  const config = makeResolvedConfig({
    database: { driver: "sqlite", url: dbPath },
    dbPath,
    migrationsPath,
    development: false,
    cors: { origins: ["https://example.com"] },
  });
  const { db, adapter } = createDatabase(config);

  try {
    await expect(runUserMigrations(db, config)).rejects.toThrow();
  } finally {
    adapter.close();
  }
});

test("runUserMigrations throws in production when migrations folder is missing", async () => {
  const dbPath = join(testRoot, "migrations-prod.sqlite");
  const migrationsPath = join(testRoot, "no-such-migrations-prod");
  const config = makeResolvedConfig({
    database: { driver: "sqlite", url: dbPath },
    dbPath,
    migrationsPath,
    development: false,
    cors: { origins: ["https://example.com"] },
  });
  const { db, adapter } = createDatabase(config);

  try {
    await expect(runUserMigrations(db, config)).rejects.toThrow("migrations folder not found");
  } finally {
    adapter.close();
  }
});
