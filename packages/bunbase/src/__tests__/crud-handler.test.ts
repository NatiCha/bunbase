import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AuthUser } from "../api/types.ts";
import { generateAllCrudHandlers, generateCrudHandlers } from "../crud/handler.ts";

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id").notNull(),
  score: integer("score").notNull().default(0),
});

const noIdTable = sqliteTable("things", {
  name: text("name").primaryKey(),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(
    "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, author_id TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0)",
  );
  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}

function mockAuth(user?: Partial<AuthUser>) {
  const u: AuthUser = {
    id: "u1",
    email: "u1@example.com",
    role: "user",
    ...user,
  };
  return async (_req: Request) => u;
}

const noAuth = async (_req: Request) => null;

// Open rules — allow all operations without restriction (explicit opt-in required since deny-by-default)
const openRules = {
  list: () => null,
  get: () => null,
  create: () => null,
  update: () => null,
  delete: () => null,
} as const;

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function makeInvalidJsonRequest(
  method: string,
  path: string,
  rawBody: string,
  extraHeaders?: Record<string, string>,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: rawBody,
  });
}

// ─── generateCrudHandlers: throw on missing id ───────────────────────────────

test("generateCrudHandlers throws when table has no id column", () => {
  const { db } = setupDb();
  expect(() => generateCrudHandlers(noIdTable, db, noAuth)).toThrow('must have an "id" column');
});

// ─── list ────────────────────────────────────────────────────────────────────

test("GET /api/posts returns all rows", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Hello", $authorId: "u1" });

  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await exact["/api/posts"]!.GET!(makeRequest("GET", "/api/posts"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.data).toHaveLength(1);
  expect(body.hasMore).toBe(false);
  expect(body.nextCursor).toBeNull();
  sqlite.close();
});

test("GET /api/posts returns empty result set", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await exact["/api/posts"]!.GET!(makeRequest("GET", "/api/posts"));
  const body = (await res.json()) as any;
  expect(body.data).toHaveLength(0);
  sqlite.close();
});

test("GET /api/posts?limit=2 respects limit and returns nextCursor", async () => {
  const { sqlite, db } = setupDb();
  for (let i = 1; i <= 5; i++) {
    sqlite
      .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
      .run({ $id: `p${i}`, $title: `Post ${i}`, $authorId: "u1" });
  }
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await exact["/api/posts"]!.GET!(makeRequest("GET", "/api/posts?limit=2"));
  const body = (await res.json()) as any;
  expect(body.data).toHaveLength(2);
  expect(body.hasMore).toBe(true);
  expect(body.nextCursor).not.toBeNull();
  sqlite.close();
});

test("GET /api/posts?filter applies filter conditions", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Alpha", $authorId: "u1" });
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p2", $title: "Beta", $authorId: "u2" });

  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await exact["/api/posts"]!.GET!(
    makeRequest(
      "GET",
      `/api/posts?filter=${encodeURIComponent(JSON.stringify({ authorId: "u1" }))}`,
    ),
  );
  const body = (await res.json()) as any;
  expect(body.data).toHaveLength(1);
  expect(body.data[0].id).toBe("p1");
  sqlite.close();
});

test("GET /api/posts applies sort order", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query(
      "INSERT INTO posts (id, title, author_id, score) VALUES ($id, $title, $authorId, $score)",
    )
    .run({ $id: "p1", $title: "A", $authorId: "u1", $score: 30 });
  sqlite
    .query(
      "INSERT INTO posts (id, title, author_id, score) VALUES ($id, $title, $authorId, $score)",
    )
    .run({ $id: "p2", $title: "B", $authorId: "u1", $score: 10 });
  sqlite
    .query(
      "INSERT INTO posts (id, title, author_id, score) VALUES ($id, $title, $authorId, $score)",
    )
    .run({ $id: "p3", $title: "C", $authorId: "u1", $score: 20 });

  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await exact["/api/posts"]!.GET!(makeRequest("GET", "/api/posts?sort=score&order=asc"));
  const body = (await res.json()) as any;
  expect(body.data.map((r: any) => r.id)).toEqual(["p2", "p3", "p1"]);
  sqlite.close();
});

test("list with cursor returns only subsequent rows (pagination)", async () => {
  const { sqlite, db } = setupDb();
  for (let i = 1; i <= 5; i++) {
    sqlite
      .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
      .run({ $id: `p${i}`, $title: `Post ${i}`, $authorId: "u1" });
  }
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res1 = await exact["/api/posts"]!.GET!(makeRequest("GET", "/api/posts?limit=2"));
  const page1 = (await res1.json()) as any;
  expect(page1.nextCursor).not.toBeNull();

  const res2 = await exact["/api/posts"]!.GET!(
    makeRequest("GET", `/api/posts?limit=2&cursor=${page1.nextCursor}`),
  );
  const page2 = (await res2.json()) as any;
  expect(page2.data).toHaveLength(2);
  const ids1 = page1.data.map((r: any) => r.id);
  const ids2 = page2.data.map((r: any) => r.id);
  expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  sqlite.close();
});

test("list returns 403 when rule denies", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), { list: () => false });
  const res = await exact["/api/posts"]!.GET!(makeRequest("GET", "/api/posts"));
  expect(res.status).toBe(403);
  sqlite.close();
});

test("list applies rule-injected SQL whereClause", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Mine", $authorId: "u1" });
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p2", $title: "Theirs", $authorId: "u2" });

  const { eq } = await import("drizzle-orm");
  const { getColumns } = await import("drizzle-orm");
  const cols = getColumns(posts);

  const { exact } = generateCrudHandlers(posts, db, mockAuth(), {
    list: () => eq(cols.authorId, "u1"),
  });
  const res = await exact["/api/posts"]!.GET!(makeRequest("GET", "/api/posts"));
  const body = (await res.json()) as any;
  expect(body.data).toHaveLength(1);
  expect(body.data[0].id).toBe("p1");
  sqlite.close();
});

// ─── get ─────────────────────────────────────────────────────────────────────

test("GET /api/posts/:id returns a row when it exists", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Hello", $authorId: "u1" });

  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await pattern["/api/posts/:id"]!.GET!(makeRequest("GET", "/api/posts/p1"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.title).toBe("Hello");
  sqlite.close();
});

test("GET /api/posts/:id returns 404 when row does not exist", async () => {
  const { sqlite, db } = setupDb();
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await pattern["/api/posts/:id"]!.GET!(makeRequest("GET", "/api/posts/nonexistent"));
  expect(res.status).toBe(404);
  sqlite.close();
});

test("GET /api/posts/:id returns 403 when rule denies", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Title", $authorId: "u1" });
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), { get: () => false });
  const res = await pattern["/api/posts/:id"]!.GET!(makeRequest("GET", "/api/posts/p1"));
  expect(res.status).toBe(403);
  sqlite.close();
});

// ─── create ──────────────────────────────────────────────────────────────────

test("POST /api/posts inserts a row and returns 201", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await exact["/api/posts"]!.POST!(
    makeRequest("POST", "/api/posts", { title: "New Post", author_id: "u1" }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.title).toBe("New Post");
  expect(body.id).toBeDefined();
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM posts").get();
  expect(count?.n).toBe(1);
  sqlite.close();
});

test("POST /api/posts uses provided id if given", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  await exact["/api/posts"]!.POST!(
    makeRequest("POST", "/api/posts", { id: "custom-id", title: "Post", author_id: "u1" }),
  );
  const row = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM posts WHERE id = $id")
    .get({ $id: "custom-id" });
  expect(row?.id).toBe("custom-id");
  sqlite.close();
});

test("POST /api/posts returns 403 when rule denies", async () => {
  const { sqlite, db } = setupDb();
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), { create: () => false });
  const res = await exact["/api/posts"]!.POST!(
    makeRequest("POST", "/api/posts", { title: "T", author_id: "u1" }),
  );
  expect(res.status).toBe(403);
  sqlite.close();
});

test("POST /api/posts returns 400 for invalid JSON before evaluating create rule", async () => {
  const { sqlite, db } = setupDb();
  let ruleCalled = false;
  const { exact } = generateCrudHandlers(posts, db, mockAuth(), {
    create: () => {
      ruleCalled = true;
      return false;
    },
  });
  const res = await exact["/api/posts"]!.POST!(
    makeInvalidJsonRequest("POST", "/api/posts", "{invalid-json"),
  );
  expect(res.status).toBe(400);
  expect(ruleCalled).toBe(false);
  sqlite.close();
});

// ─── update ──────────────────────────────────────────────────────────────────

test("PATCH /api/posts/:id modifies and returns the updated row", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Old", $authorId: "u1" });
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await pattern["/api/posts/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/posts/p1", { title: "New" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.title).toBe("New");
  sqlite.close();
});

test("PATCH /api/posts/:id returns 404 when row does not exist", async () => {
  const { sqlite, db } = setupDb();
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await pattern["/api/posts/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/posts/nope", { title: "X" }),
  );
  expect(res.status).toBe(404);
  sqlite.close();
});

test("PATCH /api/posts/:id returns 403 when rule denies", async () => {
  const { sqlite, db } = setupDb();
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), { update: () => false });
  const res = await pattern["/api/posts/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/posts/p1", { title: "X" }),
  );
  expect(res.status).toBe(403);
  sqlite.close();
});

test("PATCH /api/posts/:id returns 400 for invalid JSON before evaluating update rule", async () => {
  const { sqlite, db } = setupDb();
  let ruleCalled = false;
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), {
    update: () => {
      ruleCalled = true;
      return false;
    },
  });
  const res = await pattern["/api/posts/:id"]!.PATCH!(
    makeInvalidJsonRequest("PATCH", "/api/posts/nope", "{invalid-json"),
  );
  expect(res.status).toBe(400);
  expect(ruleCalled).toBe(false);
  sqlite.close();
});

test("PATCH maps snake_case field names to Drizzle column keys", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Title", $authorId: "u1" });
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await pattern["/api/posts/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/posts/p1", { author_id: "u2" }),
  );
  const body = (await res.json()) as any;
  expect(body.authorId).toBe("u2");
  sqlite.close();
});

test("PATCH with whereClause rule denies access when record doesn't match", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Title", $authorId: "u2" });

  const { eq, getColumns } = await import("drizzle-orm");
  const cols = getColumns(posts);
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), {
    update: () => eq(cols.authorId, "u1"),
  });
  const res = await pattern["/api/posts/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/posts/p1", { title: "New" }),
  );
  expect(res.status).toBe(403);
  sqlite.close();
});

test("PATCH succeeds when whereClause rule matches the target record", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Original", $authorId: "u1" });

  const { eq, getColumns } = await import("drizzle-orm");
  const cols = getColumns(posts);
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), {
    update: () => eq(cols.authorId, "u1"),
  });
  const res = await pattern["/api/posts/:id"]!.PATCH!(
    makeRequest("PATCH", "/api/posts/p1", { title: "Updated" }),
  );
  const body = (await res.json()) as any;
  expect(body.title).toBe("Updated");
  sqlite.close();
});

// ─── delete ──────────────────────────────────────────────────────────────────

test("DELETE /api/posts/:id removes the row and returns deleted:true", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Post", $authorId: "u1" });
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await pattern["/api/posts/:id"]!.DELETE!(makeRequest("DELETE", "/api/posts/p1"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.deleted).toBe(true);
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM posts").get();
  expect(count?.n).toBe(0);
  sqlite.close();
});

test("DELETE /api/posts/:id returns deleted:false when row does not exist", async () => {
  const { sqlite, db } = setupDb();
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), openRules);
  const res = await pattern["/api/posts/:id"]!.DELETE!(
    makeRequest("DELETE", "/api/posts/no-such-row"),
  );
  const body = (await res.json()) as any;
  expect(body.deleted).toBe(false);
  sqlite.close();
});

test("DELETE returns 403 when rule denies", async () => {
  const { sqlite, db } = setupDb();
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), { delete: () => false });
  const res = await pattern["/api/posts/:id"]!.DELETE!(makeRequest("DELETE", "/api/posts/p1"));
  expect(res.status).toBe(403);
  sqlite.close();
});

test("DELETE with whereClause rule denies when record doesn't match", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Title", $authorId: "u2" });

  const { eq, getColumns } = await import("drizzle-orm");
  const cols = getColumns(posts);
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), {
    delete: () => eq(cols.authorId, "u1"),
  });
  const res = await pattern["/api/posts/:id"]!.DELETE!(makeRequest("DELETE", "/api/posts/p1"));
  expect(res.status).toBe(403);
  sqlite.close();
});

test("DELETE succeeds when whereClause rule matches the target record", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Title", $authorId: "u1" });

  const { eq, getColumns } = await import("drizzle-orm");
  const cols = getColumns(posts);
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), {
    delete: () => eq(cols.authorId, "u1"),
  });
  const res = await pattern["/api/posts/:id"]!.DELETE!(makeRequest("DELETE", "/api/posts/p1"));
  const body = (await res.json()) as any;
  expect(body.deleted).toBe(true);
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM posts").get();
  expect(count?.n).toBe(0);
  sqlite.close();
});

// ─── generateAllCrudHandlers ─────────────────────────────────────────────────

test("generateAllCrudHandlers skips internal tables and non-table values", () => {
  const { db } = setupDb();
  const { exact } = generateAllCrudHandlers({ posts, notATable: "string-value" }, db, noAuth);
  expect(Object.keys(exact)).toEqual(["/api/posts"]);
});

test("generateAllCrudHandlers throws on tables without id column", () => {
  const { db } = setupDb();
  expect(() => generateAllCrudHandlers({ noIdTable: noIdTable as any }, db, noAuth)).toThrow(
    'BunBase: Table "things" must have an "id" column',
  );
});
