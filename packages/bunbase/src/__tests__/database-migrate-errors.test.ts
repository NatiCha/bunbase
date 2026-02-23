/**
 * Tests covering the defensive check where migrate() returns { exitCode: N }
 * instead of throwing or returning void.
 *
 * mock.module() is hoisted by Bun's test runner before static imports, so the
 * mocked migrate is seen by runUserMigrations on first import.
 */
import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testRoot = join(tmpdir(), `bunbase-db-exit-code-${Date.now()}`);
mkdirSync(testRoot, { recursive: true });

afterAll(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Replace migrate() with a function that returns { exitCode: 1 }
mock.module("drizzle-orm/bun-sqlite/migrator", () => ({
  migrate: () => ({ exitCode: 1 }),
}));

// Dynamic import after the mock is registered
const { createDatabase, runUserMigrations } = await import("../core/database.ts");
const { makeResolvedConfig } = await import("./test-helpers.ts");

function makeConfig(development: boolean) {
  const migrationsPath = join(testRoot, `migrations-${Date.now()}-${Math.random()}`);
  mkdirSync(migrationsPath, { recursive: true });
  const dbPath = join(testRoot, `db-${Date.now()}-${Math.random()}.sqlite`);
  return makeResolvedConfig({
    database: { driver: "sqlite" as const, url: dbPath },
    dbPath,
    migrationsPath,
    development,
    cors: development ? { origins: [] } : { origins: ["https://example.com"] },
  });
}

// ─── exitCode in dev mode ───────────────────────────────────────────────────

test("runUserMigrations warns and continues in dev when migrate returns exitCode", async () => {
  const cfg = makeConfig(true);
  const { db, adapter } = createDatabase(cfg);

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

  try {
    await runUserMigrations(db, cfg);
    expect(warnings.some((w) => w.includes("failed to run migrations"))).toBe(true);
  } finally {
    console.warn = origWarn;
    adapter.close();
  }
});

// ─── exitCode in prod mode ────────────────────────────────────────────────────

test("runUserMigrations throws in production when migrate returns exitCode", async () => {
  const cfg = makeConfig(false);
  const { db, adapter } = createDatabase(cfg);

  try {
    await expect(runUserMigrations(db, cfg)).rejects.toThrow("migration initialization failed");
  } finally {
    adapter.close();
  }
});
