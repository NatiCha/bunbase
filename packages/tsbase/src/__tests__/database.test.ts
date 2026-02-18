import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDatabase, runUserMigrations } from "../core/database.ts";

const testRoot = join(tmpdir(), `tsbase-db-test-${Date.now()}`);
mkdirSync(testRoot, { recursive: true });

afterAll(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// ─── createDatabase ──────────────────────────────────────────────────────────

test("createDatabase creates the SQLite file and returns db+sqlite", () => {
  const dbPath = join(testRoot, "new-dir", "test.sqlite");
  const { db, sqlite } = createDatabase({
    dbPath,
    migrationsPath: "./drizzle",
    development: true,
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
    cors: { origins: [] },
  });

  expect(existsSync(dbPath)).toBe(true);
  expect(db).toBeDefined();
  expect(sqlite).toBeDefined();

  // WAL mode should be set
  const mode = sqlite.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get([]);
  expect(mode?.journal_mode).toBe("wal");

  sqlite.close();
});

test("createDatabase works when the directory already exists", () => {
  const dir = join(testRoot, "existing-dir");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "second.sqlite");

  const { sqlite } = createDatabase({
    dbPath,
    migrationsPath: "./drizzle",
    development: true,
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
    cors: { origins: [] },
  });

  expect(existsSync(dbPath)).toBe(true);
  sqlite.close();
});

// ─── runUserMigrations ───────────────────────────────────────────────────────

test("runUserMigrations warns and continues in dev when migrations folder is missing", () => {
  const { db, sqlite } = createDatabase({
    dbPath: join(testRoot, "migrations-dev.sqlite"),
    migrationsPath: join(testRoot, "no-such-migrations"),
    development: true,
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
    cors: { origins: [] },
  });

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    // Should not throw in dev mode
    expect(() =>
      runUserMigrations(db, {
        dbPath: join(testRoot, "migrations-dev.sqlite"),
        migrationsPath: join(testRoot, "no-such-migrations"),
        development: true,
        auth: { tokenExpiry: 3600 },
        storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
        cors: { origins: [] },
      }),
    ).not.toThrow();

    expect(warnings.some((w) => w.includes("migrations folder not found"))).toBe(true);
  } finally {
    console.warn = origWarn;
    sqlite.close();
  }
});

// ─── runUserMigrations — catch block (lines 49-53) ───────────────────────────
// Create a folder with invalid _journal.json so migrate() throws a parse error.

test("runUserMigrations warns and continues in dev when migrate() throws", () => {
  const migrationsPath = join(testRoot, "invalid-meta-dev");
  mkdirSync(join(migrationsPath, "meta"), { recursive: true });
  writeFileSync(
    join(migrationsPath, "meta", "_journal.json"),
    "{ this is not valid json }",
  );

  const { db, sqlite } = createDatabase({
    dbPath: join(testRoot, "migrate-catch-dev.sqlite"),
    migrationsPath,
    development: true,
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
    cors: { origins: [] },
  });

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    expect(() =>
      runUserMigrations(db, {
        dbPath: join(testRoot, "migrate-catch-dev.sqlite"),
        migrationsPath,
        development: true,
        auth: { tokenExpiry: 3600 },
        storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
        cors: { origins: [] },
      }),
    ).not.toThrow();
    expect(
      warnings.some((w) => w.includes("failed to run migrations")),
    ).toBe(true);
  } finally {
    console.warn = origWarn;
    sqlite.close();
  }
});

test("runUserMigrations re-throws in production when migrate() throws", () => {
  const migrationsPath = join(testRoot, "invalid-meta-prod");
  mkdirSync(join(migrationsPath, "meta"), { recursive: true });
  writeFileSync(
    join(migrationsPath, "meta", "_journal.json"),
    "{ not json }",
  );

  const { db, sqlite } = createDatabase({
    dbPath: join(testRoot, "migrate-catch-prod.sqlite"),
    migrationsPath,
    development: false,
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
    cors: { origins: ["https://example.com"] },
  });

  try {
    expect(() =>
      runUserMigrations(db, {
        dbPath: join(testRoot, "migrate-catch-prod.sqlite"),
        migrationsPath,
        development: false,
        auth: { tokenExpiry: 3600 },
        storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
        cors: { origins: ["https://example.com"] },
      }),
    ).toThrow();
  } finally {
    sqlite.close();
  }
});

test("runUserMigrations throws in production when migrations folder is missing", () => {
  const { db, sqlite } = createDatabase({
    dbPath: join(testRoot, "migrations-prod.sqlite"),
    migrationsPath: join(testRoot, "no-such-migrations-prod"),
    development: false,
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
    cors: { origins: ["https://example.com"] },
  });

  try {
    expect(() =>
      runUserMigrations(db, {
        dbPath: join(testRoot, "migrations-prod.sqlite"),
        migrationsPath: join(testRoot, "no-such-migrations-prod"),
        development: false,
        auth: { tokenExpiry: 3600 },
        storage: { driver: "local", localPath: "./data/uploads", maxFileSize: 10_000_000 },
        cors: { origins: ["https://example.com"] },
      }),
    ).toThrow("migrations folder not found");
  } finally {
    sqlite.close();
  }
});
