import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { generateCrudRouter, generateAllCrudRouters } from "../crud/generator.ts";

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id").notNull(),
  score: integer("score").notNull().default(0),
});

// A table without an "id" column to test error throwing
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

function makeCtx(db: ReturnType<typeof drizzle>, userId = "u1") {
  return {
    db,
    auth: { id: userId, email: `${userId}@example.com`, role: "user" as const },
    req: new Request("http://localhost"),
  };
}

// ─── generateCrudRouter ─────────────────────────────────────────────────────

test("generateCrudRouter throws when table has no id column", () => {
  const { db } = setupDb();
  expect(() => generateCrudRouter(noIdTable, db)).toThrow(
    'must have an "id" column',
  );
});

// ─── list ───────────────────────────────────────────────────────────────────

test("list returns all rows when no input given", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Hello", $authorId: "u1" });

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.list();
  expect(result.data).toHaveLength(1);
  expect(result.hasMore).toBe(false);
  expect(result.nextCursor).toBeNull();
  sqlite.close();
});

test("list returns empty result set", async () => {
  const { sqlite, db } = setupDb();
  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.list();
  expect(result.data).toHaveLength(0);
  sqlite.close();
});

test("list respects limit and returns nextCursor when more rows exist", async () => {
  const { sqlite, db } = setupDb();
  for (let i = 1; i <= 5; i++) {
    sqlite
      .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
      .run({ $id: `p${i}`, $title: `Post ${i}`, $authorId: "u1" });
  }

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.list({ limit: 2 });
  expect(result.data).toHaveLength(2);
  expect(result.hasMore).toBe(true);
  expect(result.nextCursor).not.toBeNull();
  sqlite.close();
});

test("list applies filter conditions", async () => {
  const { sqlite, db } = setupDb();
  sqlite.query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)").run({ $id: "p1", $title: "Alpha", $authorId: "u1" });
  sqlite.query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)").run({ $id: "p2", $title: "Beta", $authorId: "u2" });

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.list({ filter: { authorId: "u1" } });
  expect(result.data).toHaveLength(1);
  expect((result.data[0] as any).id).toBe("p1");
  sqlite.close();
});

test("list applies sort order", async () => {
  const { sqlite, db } = setupDb();
  sqlite.query("INSERT INTO posts (id, title, author_id, score) VALUES ($id, $title, $authorId, $score)").run({ $id: "p1", $title: "A", $authorId: "u1", $score: 30 });
  sqlite.query("INSERT INTO posts (id, title, author_id, score) VALUES ($id, $title, $authorId, $score)").run({ $id: "p2", $title: "B", $authorId: "u1", $score: 10 });
  sqlite.query("INSERT INTO posts (id, title, author_id, score) VALUES ($id, $title, $authorId, $score)").run({ $id: "p3", $title: "C", $authorId: "u1", $score: 20 });

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.list({ sort: "score", order: "asc" });
  const ids = result.data.map((r: any) => r.id);
  expect(ids).toEqual(["p2", "p3", "p1"]);
  sqlite.close();
});

test("list with cursor returns only subsequent rows", async () => {
  const { sqlite, db } = setupDb();
  for (let i = 1; i <= 5; i++) {
    sqlite
      .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
      .run({ $id: `p${i}`, $title: `Post ${i}`, $authorId: "u1" });
  }

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const page1 = await caller.list({ limit: 2 });
  expect(page1.nextCursor).not.toBeNull();

  const page2 = await caller.list({ limit: 2, cursor: page1.nextCursor! });
  expect(page2.data).toHaveLength(2);
  // No rows should be duplicated
  const page1Ids = page1.data.map((r: any) => r.id);
  const page2Ids = page2.data.map((r: any) => r.id);
  expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  sqlite.close();
});

test("list is denied when rule returns false", async () => {
  const { sqlite, db } = setupDb();
  const router = generateCrudRouter(posts, db, { list: () => false });
  const caller = router.createCaller(makeCtx(db));

  let code = "";
  try {
    await caller.list();
  } catch (err) {
    code = (err as any).code ?? "";
  }
  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

// ─── get ────────────────────────────────────────────────────────────────────

test("get returns a row when it exists", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Hello", $authorId: "u1" });

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.get({ id: "p1" });
  expect(result).not.toBeNull();
  expect((result as any)?.title).toBe("Hello");
  sqlite.close();
});

test("get returns null when row does not exist", async () => {
  const { sqlite, db } = setupDb();
  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.get({ id: "nonexistent" });
  expect(result).toBeNull();
  sqlite.close();
});

// ─── create ─────────────────────────────────────────────────────────────────

test("create inserts a row and returns it", async () => {
  const { sqlite, db } = setupDb();
  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));

  const result = await caller.create({
    title: "New Post",
    author_id: "u1",
  });

  expect((result as any).title).toBe("New Post");
  expect((result as any).id).toBeDefined();

  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM posts").get([]);
  expect(count?.n).toBe(1);
  sqlite.close();
});

test("create uses provided id if given", async () => {
  const { sqlite, db } = setupDb();
  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));

  await caller.create({ id: "custom-id", title: "Post", author_id: "u1" });
  const row = sqlite
    .query<{ id: string }, { $id: string }>("SELECT id FROM posts WHERE id = $id")
    .get({ $id: "custom-id" });
  expect(row?.id).toBe("custom-id");
  sqlite.close();
});

test("create is denied when rule returns false", async () => {
  const { sqlite, db } = setupDb();
  const router = generateCrudRouter(posts, db, { create: () => false });
  const caller = router.createCaller(makeCtx(db));

  let code = "";
  try {
    await caller.create({ title: "T", author_id: "u1" });
  } catch (err) {
    code = (err as any).code ?? "";
  }
  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

// ─── update ─────────────────────────────────────────────────────────────────

test("update modifies and returns the updated row", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Old", $authorId: "u1" });

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.update({ id: "p1", data: { title: "New" } });
  expect((result as any)?.title).toBe("New");
  sqlite.close();
});

test("update returns null when row does not exist", async () => {
  const { sqlite, db } = setupDb();
  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.update({ id: "nope", data: { title: "X" } });
  expect(result).toBeNull();
  sqlite.close();
});

test("update is denied when rule returns false", async () => {
  const { sqlite, db } = setupDb();
  const router = generateCrudRouter(posts, db, { update: () => false });
  const caller = router.createCaller(makeCtx(db));

  let code = "";
  try {
    await caller.update({ id: "p1", data: { title: "X" } });
  } catch (err) {
    code = (err as any).code ?? "";
  }
  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

test("update with whereClause rule denies access when record doesn't match", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Title", $authorId: "u2" });

  // Rule: only allow update when authorId = u1 (but record has u2)
  const { eq } = await import("drizzle-orm");
  const { getColumns } = await import("drizzle-orm");
  const cols = getColumns(posts);
  const router = generateCrudRouter(posts, db, {
    update: () => eq(cols.authorId, "u1"),
  });
  const caller = router.createCaller(makeCtx(db, "u1"));

  let code = "";
  try {
    await caller.update({ id: "p1", data: { title: "New" } });
  } catch (err) {
    code = (err as any).code ?? "";
  }
  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

// ─── delete ─────────────────────────────────────────────────────────────────

test("delete removes the row and returns deleted: true", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Post", $authorId: "u1" });

  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.delete({ id: "p1" });
  expect(result.deleted).toBe(true);

  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM posts").get([]);
  expect(count?.n).toBe(0);
  sqlite.close();
});

test("delete returns deleted: false when row does not exist", async () => {
  const { sqlite, db } = setupDb();
  const caller = generateCrudRouter(posts, db).createCaller(makeCtx(db));
  const result = await caller.delete({ id: "no-such-row" });
  expect(result.deleted).toBe(false);
  sqlite.close();
});

test("delete is denied when rule returns false", async () => {
  const { sqlite, db } = setupDb();
  const router = generateCrudRouter(posts, db, { delete: () => false });
  const caller = router.createCaller(makeCtx(db));

  let code = "";
  try {
    await caller.delete({ id: "p1" });
  } catch (err) {
    code = (err as any).code ?? "";
  }
  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

test("delete with whereClause rule denies when record doesn't match", async () => {
  const { sqlite, db } = setupDb();
  sqlite
    .query("INSERT INTO posts (id, title, author_id) VALUES ($id, $title, $authorId)")
    .run({ $id: "p1", $title: "Title", $authorId: "u2" });

  const { eq, getColumns } = await import("drizzle-orm");
  const cols = getColumns(posts);
  const router = generateCrudRouter(posts, db, {
    delete: () => eq(cols.authorId, "u1"),
  });
  const caller = router.createCaller(makeCtx(db, "u1"));

  let code = "";
  try {
    await caller.delete({ id: "p1" });
  } catch (err) {
    code = (err as any).code ?? "";
  }
  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

// ─── generateAllCrudRouters ─────────────────────────────────────────────────

test("generateAllCrudRouters skips internal tables and non-table values", () => {
  const { db } = setupDb();
  const routers = generateAllCrudRouters(
    {
      posts,
      notATable: "string-value",
    },
    db,
  );
  expect(Object.keys(routers)).toEqual(["posts"]);
});

test("generateAllCrudRouters skips tables without id and logs warning", () => {
  const { db } = setupDb();
  // noIdTable has 'name' as PK but no 'id' column → should warn and skip
  const routers = generateAllCrudRouters({ noIdTable: noIdTable as any }, db);
  expect(Object.keys(routers)).toHaveLength(0);
});
