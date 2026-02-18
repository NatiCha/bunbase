/**
 * Tests covering lines 44-47 in core/database.ts — the defensive check where
 * migrate() returns { exitCode: N } instead of throwing or returning void.
 *
 * The throw on line 45-47 lands in the catch block (line 49):
 *   - dev mode  → console.warn + return  (lines 50-52)
 *   - prod mode → re-throw               (line 54)
 *
 * mock.module() is hoisted by Bun's test runner before static imports, so the
 * mocked migrate is seen by runUserMigrations on first import.
 */
import { test, expect, afterAll, mock } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const testRoot = join(tmpdir(), `tsbase-db-exit-code-${Date.now()}`);
mkdirSync(testRoot, { recursive: true });

afterAll(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// Replace migrate() with a function that returns { exitCode: 1 }
mock.module("drizzle-orm/bun-sqlite/migrator", () => ({
  migrate: () => ({ exitCode: 1 }),
}));

// Dynamic import after the mock is registered
const { createDatabase, runUserMigrations } = await import("../core/database.ts");

function makeConfig(development: boolean) {
  const migrationsPath = join(testRoot, `migrations-${Date.now()}-${Math.random()}`);
  mkdirSync(migrationsPath, { recursive: true });
  return {
    dbPath: join(testRoot, `db-${Date.now()}-${Math.random()}.sqlite`),
    migrationsPath,
    development,
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local" as const, localPath: "./data/uploads", maxFileSize: 10_000_000 },
    cors: { origins: development ? [] : ["https://example.com"] },
  };
}

// ─── lines 44-47 + 49-52: exitCode in dev mode ───────────────────────────────

test("runUserMigrations warns and continues in dev when migrate returns exitCode", () => {
  const cfg = makeConfig(true);
  const { db, sqlite } = createDatabase(cfg);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    expect(() => runUserMigrations(db, cfg)).not.toThrow();
    expect(warnings.some((w) => w.includes("failed to run migrations"))).toBe(true);
  } finally {
    console.warn = origWarn;
    sqlite.close();
  }
});

// ─── lines 44-47 + 49 + 54: exitCode in prod mode ────────────────────────────

test("runUserMigrations throws in production when migrate returns exitCode", () => {
  const cfg = makeConfig(false);
  const { db, sqlite } = createDatabase(cfg);

  try {
    expect(() => runUserMigrations(db, cfg)).toThrow(
      "migration initialization failed",
    );
  } finally {
    sqlite.close();
  }
});
