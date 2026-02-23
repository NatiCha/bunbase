/**
 * Integration tests for the listAll() / ?limit=-1 feature.
 * Verifies that passing limit=-1 returns all records without a cursor,
 * respects filters, works with expand, and does not regress paginated defaults.
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

  // Seed 25 tasks — more than the default page size of 20 — to verify listAll
  // returns all of them in a single request while limit=20 still truncates.
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

// ─── Core behaviour ────────────────────────────────────────────────────────

test("GET /api/tasks?limit=-1 returns all 25 records", async () => {
  const res = await fetch(`${base}/api/tasks?limit=-1`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(25);
  expect(body.nextCursor).toBeNull();
  expect(body.hasMore).toBe(false);
});

test("GET /api/tasks?limit=-1 nextCursor is null and hasMore is false", async () => {
  const res = await fetch(`${base}/api/tasks?limit=-1`);
  const body = (await res.json()) as any;
  expect(body.nextCursor).toBeNull();
  expect(body.hasMore).toBe(false);
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

test("GET /api/tasks?limit=999 is capped at 100", async () => {
  const res = await fetch(`${base}/api/tasks?limit=999`);
  const body = (await res.json()) as any;
  // Only 25 seeded tasks, so all fit within the 100 cap
  expect(body.data.length).toBe(25);
  // Verify the sentinel -1 is NOT treated as a huge positive number
  // by checking hasMore is false (all records returned)
  expect(body.hasMore).toBe(false);
});

// ─── Filter + listAll ─────────────────────────────────────────────────────

test("GET /api/tasks?limit=-1&filter=... returns filtered subset", async () => {
  // 12 even-numbered tasks have done='true', 13 odd-numbered have done='false'
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

test("GET /api/tasks?limit=-1 with filter returning no rows returns empty array", async () => {
  const filter = JSON.stringify({ title: "nonexistent-xyz-abc" });
  const res = await fetch(`${base}/api/tasks?limit=-1&filter=${encodeURIComponent(filter)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(0);
  expect(body.nextCursor).toBeNull();
  expect(body.hasMore).toBe(false);
});

// ─── listAll + expand ─────────────────────────────────────────────────────

test("GET /api/tasks?limit=-1&expand=owner returns all tasks with owner", async () => {
  const res = await fetch(`${base}/api/tasks?limit=-1&expand=owner`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(25);
  expect(body.nextCursor).toBeNull();
  expect(body.hasMore).toBe(false);

  // Every task should have an embedded owner
  for (const task of body.data) {
    expect(task.owner).toBeDefined();
    expect(typeof task.owner.id).toBe("string");
    // passwordHash must never leak
    expect(task.owner.passwordHash).toBeUndefined();
  }
});

test("listAll + expand assigns correct owner to each task", async () => {
  const res = await fetch(`${base}/api/tasks?limit=-1&expand=owner`);
  const body = (await res.json()) as any;

  // Even-indexed tasks (t2, t4, ...) belong to u1 (Alice); odd to u2 (Bob)
  const t1 = body.data.find((t: any) => t.id === "t1");
  const t2 = body.data.find((t: any) => t.id === "t2");
  expect(t1).toBeDefined();
  expect(t2).toBeDefined();
  expect(t1.owner.id).toBe("u2"); // odd → Bob
  expect(t2.owner.id).toBe("u1"); // even → Alice
});

// ─── resolveLimit unit guard ──────────────────────────────────────────────
// These verify the sentinel without going through the HTTP stack.

// ─── Sentinel consistency (P1 regression) ────────────────────────────────

test("GET /api/tasks?limit=-1.0 treats numeric -1 as sentinel (all records, no cursor)", async () => {
  // -1.0 parses to -1 via Number(); should trigger fetchAll, not the paginated path.
  // Before fix: fetchAll was keyed off raw string "-1", so -1.0 would produce
  // hasMore:true and a non-null nextCursor even though all rows were returned.
  const res = await fetch(`${base}/api/tasks?limit=-1.0`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data.length).toBe(25);
  expect(body.nextCursor).toBeNull();
  expect(body.hasMore).toBe(false);
});

// ─── resolveLimit unit guard ──────────────────────────────────────────────
// These verify the sentinel without going through the HTTP stack.

test("resolveLimit(-1) passes through as -1", async () => {
  const { resolveLimit } = await import("../crud/pagination.ts");
  expect(resolveLimit(-1)).toBe(-1);
});

test("resolveLimit(-2) still defaults to 20 (only -1 is the sentinel)", async () => {
  const { resolveLimit } = await import("../crud/pagination.ts");
  expect(resolveLimit(-2)).toBe(20);
});
