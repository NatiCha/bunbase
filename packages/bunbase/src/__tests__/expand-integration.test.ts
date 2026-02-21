/**
 * Integration tests for the expand/relations feature.
 * Verifies that ?expand=relation returns nested relational data.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../core/server.ts";
import { defineRelations } from "../crud/relations.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const root = join(tmpdir(), `bunbase-expand-intg-${Date.now()}`);
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

// Second server WITHOUT relations to test the 400 path
const schemaNoRelations = {
  users: usersTable,
  tasks: tasksTable,
};

let serverWithRelations: ReturnType<typeof createServer>;
let serverNoRelations: ReturnType<typeof createServer>;
let serverSecure: ReturnType<typeof createServer>; // tasks open, users.list denied
let serverFiltered: ReturnType<typeof createServer>; // tasks open, users.list returns SQL whereClause
let serverWR: ReturnType<typeof Bun.serve>;
let serverNR: ReturnType<typeof Bun.serve>;
let serverSEC: ReturnType<typeof Bun.serve>;
let serverFIL: ReturnType<typeof Bun.serve>;
let baseWR: string;
let baseNR: string;
let baseSecure: string;
let baseFiltered: string;

beforeAll(async () => {
  const dbPathWR = join(root, "db-with-relations.sqlite");
  const dbPathNR = join(root, "db-no-relations.sqlite");

  const openRules = {
    list: () => null,
    view: () => null,
    get: () => null,
    create: () => null,
    update: () => null,
    delete: () => null,
  };

  // Server WITH relations
  serverWithRelations = createServer({
    schema,
    relations,
    rules: { tasks: openRules, users: openRules },
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPathWR },
      dbPath: dbPathWR,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-wr"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-wr"),
    }),
  });

  await serverWithRelations.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', name TEXT)",
  );
  await serverWithRelations.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT)",
  );

  await serverWithRelations.adapter.rawExecute(
    "INSERT INTO users (id, email, role, name) VALUES ('u1', 'alice@example.com', 'user', 'Alice')",
  );
  await serverWithRelations.adapter.rawExecute(
    "INSERT INTO users (id, email, role, name) VALUES ('u2', 'bob@example.com', 'user', 'Bob')",
  );
  await serverWithRelations.adapter.rawExecute(
    "INSERT INTO tasks (id, title, owner_id) VALUES ('t1', 'Task 1', 'u1')",
  );
  await serverWithRelations.adapter.rawExecute(
    "INSERT INTO tasks (id, title, owner_id) VALUES ('t2', 'Task 2', 'u2')",
  );
  await serverWithRelations.adapter.rawExecute(
    "INSERT INTO tasks (id, title, owner_id) VALUES ('t3', 'Task 3', 'u1')",
  );

  serverWR = serverWithRelations.listen(0);
  baseWR = `http://localhost:${serverWR.port}`;

  // Server WITHOUT relations (for 400 error path)
  serverNoRelations = createServer({
    schema: schemaNoRelations,
    // no relations passed
    rules: { tasks: openRules, users: openRules },
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPathNR },
      dbPath: dbPathNR,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-nr"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-nr"),
    }),
  });

  await serverNoRelations.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', name TEXT)",
  );
  await serverNoRelations.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT)",
  );
  await serverNoRelations.adapter.rawExecute(
    "INSERT INTO tasks (id, title, owner_id) VALUES ('t1', 'Task 1', 'u1')",
  );

  serverNR = serverNoRelations.listen(0);
  baseNR = `http://localhost:${serverNR.port}`;

  // Server with tasks open but users.list denied — tests related-table rule enforcement
  const dbPathSEC = join(root, "db-secure.sqlite");
  serverSecure = createServer({
    schema,
    relations,
    rules: {
      tasks: openRules,
      users: {
        ...openRules,
        // Deny list so expand of user data is blocked
        list: () => false,
      },
    },
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPathSEC },
      dbPath: dbPathSEC,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-sec"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-sec"),
    }),
  });

  await serverSecure.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', name TEXT)",
  );
  await serverSecure.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT)",
  );
  await serverSecure.adapter.rawExecute(
    "INSERT INTO users (id, email, role, name) VALUES ('u1', 'alice@secure.com', 'user', 'Alice')",
  );
  await serverSecure.adapter.rawExecute(
    "INSERT INTO tasks (id, title, owner_id) VALUES ('t1', 'Secure Task', 'u1')",
  );

  serverSEC = serverSecure.listen(0);
  baseSecure = `http://localhost:${serverSEC.port}`;

  // Server with tasks open but users.list returns a SQL whereClause (filtered) —
  // tests that SQL-filtered list rules are treated as denial for expand.
  const dbPathFIL = join(root, "db-filtered.sqlite");
  serverFiltered = createServer({
    schema,
    relations,
    rules: {
      tasks: openRules,
      users: {
        ...openRules,
        // Returns a SQL whereClause — "allowed but row-level filtered"
        // Expand cannot apply this filter to nested queries, so owner must be stripped.
        list: () => eq(usersTable.id, "no-such-user"),
      },
    },
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPathFIL },
      dbPath: dbPathFIL,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-fil"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-fil"),
    }),
  });

  await serverFiltered.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', name TEXT)",
  );
  await serverFiltered.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT)",
  );
  await serverFiltered.adapter.rawExecute(
    "INSERT INTO users (id, email, role, name) VALUES ('u1', 'alice@filtered.com', 'user', 'Alice')",
  );
  await serverFiltered.adapter.rawExecute(
    "INSERT INTO tasks (id, title, owner_id) VALUES ('t1', 'Filtered Task', 'u1')",
  );

  serverFIL = serverFiltered.listen(0);
  baseFiltered = `http://localhost:${serverFIL.port}`;
});

afterAll(() => {
  serverWR?.stop(true);
  serverNR?.stop(true);
  serverSEC?.stop(true);
  serverFIL?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

// ─── Expand list tests ─────────────────────────────────────────────────────

test("GET /api/tasks?expand=owner returns tasks with embedded owner", async () => {
  const res = await fetch(`${baseWR}/api/tasks?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(3);

  // Each task should have an embedded owner
  const t1 = body.data.find((t: any) => t.id === "t1");
  expect(t1).toBeDefined();
  expect(t1.title).toBe("Task 1");
  expect(t1.owner).toBeDefined();
  expect(t1.owner.id).toBe("u1");
  expect(t1.owner.name).toBe("Alice");
});

test("GET /api/tasks?expand=owner returns correct owner for each task", async () => {
  const res = await fetch(`${baseWR}/api/tasks?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;

  const t2 = body.data.find((t: any) => t.id === "t2");
  expect(t2.owner.id).toBe("u2");
  expect(t2.owner.name).toBe("Bob");
});

test("GET /api/tasks?expand=owner respects pagination", async () => {
  const res = await fetch(`${baseWR}/api/tasks?expand=owner&limit=2`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.data.length).toBe(2);
  expect(body.hasMore).toBe(true);
  expect(body.nextCursor).not.toBeNull();

  // Each task on this page should also have the owner expanded
  for (const task of body.data) {
    expect(task.owner).toBeDefined();
    expect(typeof task.owner.id).toBe("string");
  }
});

test("GET /api/tasks without expand returns plain tasks (no owner field)", async () => {
  const res = await fetch(`${baseWR}/api/tasks`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.data).toBeArray();

  const t1 = body.data.find((t: any) => t.id === "t1");
  expect(t1).toBeDefined();
  expect(t1.owner).toBeUndefined();
});

test("GET /api/tasks?expand=owner returns 400 when no relations configured", async () => {
  const res = await fetch(`${baseNR}/api/tasks?expand=owner`);
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.message).toContain("expand is not supported");
});

// ─── Expand get (by ID) tests ──────────────────────────────────────────────

test("GET /api/tasks/:id?expand=owner returns task with embedded owner", async () => {
  const res = await fetch(`${baseWR}/api/tasks/t1?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.id).toBe("t1");
  expect(body.title).toBe("Task 1");
  expect(body.owner).toBeDefined();
  expect(body.owner.id).toBe("u1");
  expect(body.owner.name).toBe("Alice");
});

test("GET /api/tasks/:id without expand returns plain record", async () => {
  const res = await fetch(`${baseWR}/api/tasks/t1`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.id).toBe("t1");
  expect(body.owner).toBeUndefined();
});

test("GET /api/tasks/:id?expand=owner returns 404 for nonexistent record", async () => {
  const res = await fetch(`${baseWR}/api/tasks/nonexistent?expand=owner`);
  expect(res.status).toBe(404);
});

test("GET /api/tasks/:id?expand=owner returns 400 when no relations configured", async () => {
  const res = await fetch(`${baseNR}/api/tasks/t1?expand=owner`);
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.message).toContain("expand is not supported");
});

// ─── Security boundary tests ───────────────────────────────────────────────

test("expand does not return passwordHash from related user objects", async () => {
  const res = await fetch(`${baseWR}/api/tasks?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  for (const task of body.data) {
    if (task.owner) {
      expect(task.owner.passwordHash).toBeUndefined();
      expect((task.owner as any).password_hash).toBeUndefined();
    }
  }
});

test("expand on GET does not return passwordHash from related user", async () => {
  const res = await fetch(`${baseWR}/api/tasks/t1?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.owner).toBeDefined();
  expect(body.owner.passwordHash).toBeUndefined();
});

test("expand respects related table list rules — denied relation is stripped", async () => {
  // tasks list is allowed, users list is denied → owner should be stripped from expanded response
  const res = await fetch(`${baseSecure}/api/tasks?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(1);
  // owner field should not be present because users.list is denied
  expect(body.data[0].owner).toBeUndefined();
});

test("expand GET respects related table list rules — denied relation is stripped", async () => {
  const res = await fetch(`${baseSecure}/api/tasks/t1?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.id).toBe("t1");
  // owner should not be present because users.list is denied
  expect(body.owner).toBeUndefined();
});

// ─── SQL whereClause rule tests ────────────────────────────────────────────

test("expand list strips relation when related table list rule returns SQL whereClause", async () => {
  // users.list returns eq(usersTable.id, "no-such-user") — allowed but row-filtered.
  // Expand cannot apply this SQL filter to nested queries, so owner must be stripped.
  const res = await fetch(`${baseFiltered}/api/tasks?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(1);
  expect(body.data[0].owner).toBeUndefined();
});

test("expand GET strips relation when related table list rule returns SQL whereClause", async () => {
  const res = await fetch(`${baseFiltered}/api/tasks/t1?expand=owner`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.id).toBe("t1");
  expect(body.owner).toBeUndefined();
});

// ─── Invalid/unknown expand key tests ─────────────────────────────────────

test("expand with unknown relation key returns 200 with plain data (no 500)", async () => {
  const res = await fetch(`${baseWR}/api/tasks?expand=nonexistent`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  // Unknown key is silently dropped — plain rows returned
  expect(body.data).toBeArray();
  expect(body.data.length).toBe(3);
  expect(body.data[0].nonexistent).toBeUndefined();
});

test("expand with nested/dotted key returns 200 with plain data (no 500)", async () => {
  const res = await fetch(`${baseWR}/api/tasks?expand=owner.foo`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  // Dotted key is not a valid top-level relation — dropped without error
  expect(body.data).toBeArray();
});
