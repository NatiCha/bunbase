/**
 * Integration tests for list pagination limits.
 *
 * SECURITY: `?limit=-1` (and any non-positive value) must NOT dump the whole
 * table — that previously let any list-permitted caller exfiltrate every row.
 * `resolveLimit` clamps such values to the default page size; the upper bound is
 * always MAX_LIMIT (100). These tests guard that behavior plus normal pagination.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createServer } from "../core/server.ts";
import { defineRelations } from "../crud/relations.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const root = join(tmpdir(), `bunbase-listall-${Date.now()}`);
mkdirSync(root, { recursive: true });

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  name: text("name"),
});

const tasksTable = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: text("done").notNull().default("false"),
  ownerId: text("owner_id"),
});

const schema = { users: usersTable, tasks: tasksTable };

const relations = defineRelations(schema, (r) => ({
  tasks: {
    owner: r.one.users({
      from: r.tasks.ownerId,
      to: r.users.id,
    }),
  },
}));

const openRules = {
  list: () => null,
  get: () => null,
  create: () => null,
  update: () => null,
  delete: () => null,
};

let srv: ReturnType<typeof Bun.serve>;
let base: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  const dbPath = join(root, "db.sqlite");

  server = createServer({
    schema,
    relations,
    rules: { tasks: openRules, users: openRules },
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPath },
      dbPath,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle"),
    }),
  });

  await server.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', name TEXT)",
  );
  await server.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done TEXT NOT NULL DEFAULT 'false', owner_id TEXT)",
  );

  // Seed two users
  await server.adapter.rawExecute(
    "INSERT INTO users (id, email, role, name) VALUES ('u1', 'alice@example.com', 'user', 'Alice')",
  );
  await server.adapter.rawExecute(
    "INSERT INTO users (id, email, role, name) VALUES ('u2', 'bob@example.com', 'user', 'Bob')",
  );

  // Seed 25 tasks — more than the default page size of 20 — to verify that
  // limit=-1 does NOT dump all of them and that limit=20 truncates as expected.
  for (let i = 1; i <= 25; i++) {
    const done = i % 2 === 0 ? "true" : "false";
    const ownerId = i % 2 === 0 ? "u1" : "u2";
    await server.adapter.rawExecute(
      `INSERT INTO tasks (id, title, done, owner_id) VALUES ('t${i}', 'Task ${i}', '${done}', '${ownerId}')`,
    );
  }

  srv = server.listen(0);
  base = `http://localhost:${srv.port}`;
});

afterAll(() => {
  srv?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

// ─── Security: limit=-1 is NOT a table dump ────────────────────────────────

test("GET /api/tasks?limit=-1 clamps to the default page size (no table dump)", async () => {
  const res = await fetch(`${base}/api/tasks?limit=-1`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
  // 25 rows seeded; -1 must clamp to the default page (20), not return all.
  expect(body.data.length).toBe(20);
  expect(body.nextCursor).not.toBeNull();
  expect(body.hasMore).toBe(true);
});

test("GET /api/tasks?limit=-1.0 also clamps to the default page size", async () => {
  const res = await fetch(`${base}/api/tasks?limit=-1.0`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data.length).toBe(20);
  expect(body.hasMore).toBe(true);
});

test("GET /api/tasks?limit=-1&expand=owner still paginates (and never leaks passwordHash)", async () => {
  const res = await fetch(`${base}/api/tasks?limit=-1&expand=owner`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(20);
  expect(body.hasMore).toBe(true);

  for (const task of body.data) {
    expect(task.owner).toBeDefined();
    expect(typeof task.owner.id).toBe("string");
    // passwordHash must never leak, even via expand
    expect(task.owner.passwordHash).toBeUndefined();
  }
});

// ─── Regression guard: default pagination still works ─────────────────────

test("GET /api/tasks (no limit) defaults to 20 records", async () => {
  const res = await fetch(`${base}/api/tasks`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data.length).toBe(20);
  expect(body.hasMore).toBe(true);
  expect(body.nextCursor).not.toBeNull();
});

test("GET /api/tasks?limit=5 returns 5 records", async () => {
  const res = await fetch(`${base}/api/tasks?limit=5`);
  const body = (await res.json()) as any;
  expect(body.data.length).toBe(5);
  expect(body.hasMore).toBe(true);
});

test("GET /api/tasks?limit=999 is capped at 100 (here, the 25 seeded rows)", async () => {
  const res = await fetch(`${base}/api/tasks?limit=999`);
  const body = (await res.json()) as any;
  // Only 25 seeded tasks, all within the 100 cap → all returned.
  expect(body.data.length).toBe(25);
  expect(body.hasMore).toBe(false);
});

// ─── Filter still works with a clamped page ───────────────────────────────

test("GET /api/tasks?filter=... returns the filtered subset within the page", async () => {
  // 12 even-numbered tasks have done='true' (< 20, so all fit in one page).
  const filter = JSON.stringify({ done: "true" });
  const res = await fetch(`${base}/api/tasks?limit=-1&filter=${encodeURIComponent(filter)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(12);
  expect(body.nextCursor).toBeNull();
  expect(body.hasMore).toBe(false);
  for (const task of body.data) {
    expect(task.done).toBe("true");
  }
});

test("GET /api/tasks with a filter matching no rows returns an empty array", async () => {
  const filter = JSON.stringify({ title: "nonexistent-xyz-abc" });
  const res = await fetch(`${base}/api/tasks?filter=${encodeURIComponent(filter)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(0);
  expect(body.nextCursor).toBeNull();
  expect(body.hasMore).toBe(false);
});

// ─── resolveLimit unit guard ──────────────────────────────────────────────

test("resolveLimit clamps non-positive values to the default (no -1 sentinel)", async () => {
  const { resolveLimit } = await import("../crud/pagination.ts");
  expect(resolveLimit(-1)).toBe(20);
  expect(resolveLimit(-2)).toBe(20);
  expect(resolveLimit(0)).toBe(20);
  expect(resolveLimit(undefined)).toBe(20);
  expect(resolveLimit(Number.NaN)).toBe(20);
});

test("resolveLimit caps positive values at MAX_LIMIT (100)", async () => {
  const { resolveLimit } = await import("../crud/pagination.ts");
  expect(resolveLimit(50)).toBe(50);
  expect(resolveLimit(999)).toBe(100);
});
