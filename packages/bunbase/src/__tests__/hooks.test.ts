/**
 * Unit tests for lifecycle hooks in CRUD handlers.
 * Uses in-memory SQLite and direct handler calls — no HTTP server needed.
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { ApiError } from "../api/helpers.ts";
import type { AuthUser } from "../api/types.ts";
import { generateCrudHandlers } from "../crud/handler.ts";

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id"),
  priority: text("priority").notNull().default("normal"),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT, priority TEXT NOT NULL DEFAULT 'normal')",
  );
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

function mockAuth(user?: Partial<AuthUser>) {
  const u: AuthUser = { id: "u1", email: "u@example.com", role: "user", ...user };
  return async (_req: Request) => u;
}

const noAuth = async (_req: Request): Promise<AuthUser | null> => null;

// Open rules — allow all operations without restriction (explicit opt-in required since deny-by-default)
const openRules = {
  list: () => null,
  get: () => null,
  create: () => null,
  update: () => null,
  delete: () => null,
} as const;

function makeRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── beforeCreate ─────────────────────────────────────────────────────────────

test("beforeCreate: modifies data — created record reflects changes", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeCreate: async ({ data, auth }) => ({ ...data, ownerId: auth?.id }),
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "My task" }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.ownerId).toBe("u1");
  sqlite.close();
});

test("beforeCreate: returns void — original data passes through unchanged", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeCreate: async () => {
      /* intentionally return nothing */
    },
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Unchanged" }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.title).toBe("Unchanged");
  sqlite.close();
});

test("beforeCreate: throws ApiError(403) — returns 403 and no row inserted", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeCreate: () => {
      throw new ApiError("FORBIDDEN", "Nope", 403);
    },
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Blocked" }),
  );
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("FORBIDDEN");
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM tasks").get();
  expect(count?.n).toBe(0);
  sqlite.close();
});

test("beforeCreate: throws ApiError(409) — returns 409 conflict response", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeCreate: () => {
      throw new ApiError("CONFLICT", "Already exists", 409);
    },
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Dup" }),
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("CONFLICT");
  sqlite.close();
});

test("beforeCreate: throws generic Error — returns 500 with HOOK_ERROR code", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeCreate: () => {
      throw new Error("Something went wrong");
    },
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Fail" }),
  );
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("HOOK_ERROR");
  sqlite.close();
});

test("beforeCreate: async hook works (returns a Promise)", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeCreate: async ({ data }) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { ...data, priority: "high" };
    },
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Async task" }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.priority).toBe("high");
  sqlite.close();
});

// ── afterCreate ───────────────────────────────────────────────────────────────

test("afterCreate: receives created record", async () => {
  const { sqlite, db } = setupDb();
  let captured: Record<string, unknown> | null = null;
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    afterCreate: async ({ record }) => {
      captured = record;
    },
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Check" }),
  );
  expect(res.status).toBe(201);
  expect(captured).not.toBeNull();
  expect((captured as any).id).toBe("t1");
  sqlite.close();
});

test("afterCreate: error in hook does not affect 201 response", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    afterCreate: async () => {
      throw new Error("side-effect failed");
    },
  });
  const res = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Safe" }),
  );
  expect(res.status).toBe(201);
  sqlite.close();
});

// ── beforeUpdate ──────────────────────────────────────────────────────────────

test("beforeUpdate: modifies data — updated record reflects changes", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title, priority) VALUES ('t1', 'Old', 'normal')");
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeUpdate: async ({ data }) => ({ ...data, priority: "high" }),
  });
  const res = await pattern["/api/tasks/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/tasks/t1", { title: "New" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.priority).toBe("high");
  sqlite.close();
});

test("beforeUpdate: receives existing record in context", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title, priority) VALUES ('t1', 'Original', 'normal')");
  let capturedExisting: Record<string, unknown> | null = null;
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeUpdate: async ({ existing }) => {
      capturedExisting = existing;
    },
  });
  await pattern["/api/tasks/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/tasks/t1", { title: "Updated" }),
  );
  expect(capturedExisting).not.toBeNull();
  expect((capturedExisting as any).title).toBe("Original");
  sqlite.close();
});

test("beforeUpdate: throws ApiError(403) — returns 403, no update applied", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Locked')");
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeUpdate: () => {
      throw new ApiError("FORBIDDEN", "Cannot edit", 403);
    },
  });
  const res = await pattern["/api/tasks/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/tasks/t1", { title: "Changed" }),
  );
  expect(res.status).toBe(403);
  const row = sqlite.query<{ title: string }, []>("SELECT title FROM tasks").get();
  expect(row?.title).toBe("Locked");
  sqlite.close();
});

test("beforeUpdate: returns 404 without running hook when record does not exist", async () => {
  const { sqlite, db } = setupDb();
  let hookCalled = false;
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeUpdate: async () => {
      hookCalled = true;
    },
  });
  const res = await pattern["/api/tasks/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/tasks/nonexistent", { title: "X" }),
  );
  expect(res.status).toBe(404);
  expect(hookCalled).toBe(false);
  sqlite.close();
});

test("beforeUpdate: throws generic Error — returns 500 with HOOK_ERROR", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Title')");
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeUpdate: () => {
      throw new Error("unexpected");
    },
  });
  const res = await pattern["/api/tasks/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/tasks/t1", { title: "X" }),
  );
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("HOOK_ERROR");
  sqlite.close();
});

// ── afterUpdate ───────────────────────────────────────────────────────────────

test("afterUpdate: receives updated record", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Before')");
  let captured: Record<string, unknown> | null = null;
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    afterUpdate: async ({ record }) => {
      captured = record;
    },
  });
  await pattern["/api/tasks/:id"]!.PATCH!(makeRequest("PATCH", "/api/tasks/t1", { title: "After" }));
  expect((captured as any)?.title).toBe("After");
  sqlite.close();
});

test("afterUpdate: error does not affect 200 response", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Title')");
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    afterUpdate: async () => {
      throw new Error("notify failed");
    },
  });
  const res = await pattern["/api/tasks/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/tasks/t1", { title: "New" }),
  );
  expect(res.status).toBe(200);
  sqlite.close();
});

// ── beforeDelete ─────────────────────────────────────────────────────────────

test("beforeDelete: throws ApiError(403) — returns 403, record not deleted", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title, priority) VALUES ('t1', 'Critical', 'critical')");
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeDelete: ({ record }) => {
      if (record.priority === "critical") {
        throw new ApiError("FORBIDDEN", "Cannot delete critical tasks", 403);
      }
    },
  });
  const res = await pattern["/api/tasks/:id"]!.DELETE!(makeRequest("DELETE", "/api/tasks/t1"));
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("FORBIDDEN");
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM tasks").get();
  expect(count?.n).toBe(1);
  sqlite.close();
});

test("beforeDelete: throws generic Error — returns 500 with HOOK_ERROR", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Task')");
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeDelete: () => {
      throw new Error("db lookup failed");
    },
  });
  const res = await pattern["/api/tasks/:id"]!.DELETE!(makeRequest("DELETE", "/api/tasks/t1"));
  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("HOOK_ERROR");
  sqlite.close();
});

test("beforeDelete: allows deletion when no error thrown", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Task')");
  let called = false;
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    beforeDelete: async () => {
      called = true;
    },
  });
  const res = await pattern["/api/tasks/:id"]!.DELETE!(makeRequest("DELETE", "/api/tasks/t1"));
  expect(res.status).toBe(200);
  expect(called).toBe(true);
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM tasks").get();
  expect(count?.n).toBe(0);
  sqlite.close();
});

// ── afterDelete ───────────────────────────────────────────────────────────────

test("afterDelete: receives deleted record", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Gone')");
  let captured: Record<string, unknown> | null = null;
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    afterDelete: async ({ record }) => {
      captured = record;
    },
  });
  const res = await pattern["/api/tasks/:id"]!.DELETE!(makeRequest("DELETE", "/api/tasks/t1"));
  expect(res.status).toBe(200);
  expect((captured as any)?.title).toBe("Gone");
  sqlite.close();
});

test("afterDelete: error does not affect 200 response", async () => {
  const { sqlite, db } = setupDb();
  sqlite.run("INSERT INTO tasks (id, title) VALUES ('t1', 'Task')");
  const { pattern } = generateCrudHandlers(tasks, db, mockAuth(), openRules, {
    afterDelete: async () => {
      throw new Error("cleanup failed");
    },
  });
  const res = await pattern["/api/tasks/:id"]!.DELETE!(makeRequest("DELETE", "/api/tasks/t1"));
  expect(res.status).toBe(200);
  sqlite.close();
});

// ── no hooks ─────────────────────────────────────────────────────────────────

test("no hooks defined — CRUD works normally", async () => {
  const { sqlite, db } = setupDb();
  const { exact, pattern } = generateCrudHandlers(tasks, db, noAuth, openRules);

  // Create
  const createRes = await exact["/api/tasks"]!.POST!(
    makeRequest("POST", "/api/tasks", { id: "t1", title: "Normal" }),
  );
  expect(createRes.status).toBe(201);

  // Update
  const updateRes = await pattern["/api/tasks/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/tasks/t1", { title: "Updated" }),
  );
  expect(updateRes.status).toBe(200);

  // Delete
  const deleteRes = await pattern["/api/tasks/:id"]!.DELETE!(makeRequest("DELETE", "/api/tasks/t1"));
  const deleteBody = (await deleteRes.json()) as any;
  expect(deleteBody.deleted).toBe(true);

  sqlite.close();
});
