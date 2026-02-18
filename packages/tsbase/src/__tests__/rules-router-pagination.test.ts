import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { getColumns } from "drizzle-orm";
import { generateCrudRouter } from "../crud/generator.ts";
import {
  buildCursorCondition,
  buildNextCursor,
  buildOrderBy,
} from "../crud/pagination.ts";
import { createAppRouter } from "../trpc/router.ts";
import { publicProcedure, router } from "../trpc/procedures.ts";

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull(),
});

const feed = sqliteTable("feed", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

test("view rule is enforced for get reads", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL)");
  sqlite
    .query("INSERT INTO posts (id, author_id) VALUES ($id, $authorId)")
    .run({ $id: "p1", $authorId: "u1" });

  const db = drizzle({ client: sqlite });
  const postsRouter = generateCrudRouter(posts, db, {
    view: () => false,
  });

  const caller = postsRouter.createCaller({
    db,
    auth: { id: "u1", email: "u1@example.com", role: "user" },
    req: new Request("http://localhost"),
  });

  let code = "";
  try {
    await caller.get({ id: "p1" });
  } catch (error) {
    code = (error as { code?: string }).code ?? "";
  }

  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

test("get rule alias remains supported for reads", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL)");
  sqlite
    .query("INSERT INTO posts (id, author_id) VALUES ($id, $authorId)")
    .run({ $id: "p1", $authorId: "u1" });

  const db = drizzle({ client: sqlite });
  const postsRouter = generateCrudRouter(posts, db, {
    get: () => false,
  });

  const caller = postsRouter.createCaller({
    db,
    auth: { id: "u1", email: "u1@example.com", role: "user" },
    req: new Request("http://localhost"),
  });

  let code = "";
  try {
    await caller.get({ id: "p1" });
  } catch (error) {
    code = (error as { code?: string }).code ?? "";
  }

  expect(code).toBe("FORBIDDEN");
  sqlite.close();
});

test("extend router merges at root and collisions fail", async () => {
  const baseRouters = {
    posts: router({
      ping: publicProcedure.query(() => "pong"),
    }),
  };

  const extendRouter = router({
    health: publicProcedure.query(() => "ok"),
  });

  const appRouter = createAppRouter(baseRouters, extendRouter);
  const caller = appRouter.createCaller({
    db: {} as never,
    auth: null,
    req: new Request("http://localhost"),
  });

  expect(await caller.health()).toBe("ok");
  expect(await caller.posts.ping()).toBe("pong");

  const conflicting = router({
    posts: router({
      alt: publicProcedure.query(() => "collision"),
    }),
  });

  expect(() => createAppRouter(baseRouters, conflicting)).toThrow(
    "Cannot merge extend router",
  );
});

test("composite cursor does not skip rows when sort values tie", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE feed (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
  const rows: Array<{ id: string; createdAt: number }> = [
    { id: "a", createdAt: 100 },
    { id: "b", createdAt: 100 },
    { id: "c", createdAt: 100 },
    { id: "d", createdAt: 200 },
    { id: "e", createdAt: 200 },
  ];
  for (const { id, createdAt } of rows) {
    sqlite
      .query("INSERT INTO feed (id, created_at) VALUES ($id, $createdAt)")
      .run({ $id: id, $createdAt: createdAt });
  }

  const db = drizzle({ client: sqlite });
  const columns = getColumns(feed);
  const idColumn = columns.id;
  const sortColumn = columns.createdAt;
  const orderBy = buildOrderBy(idColumn, sortColumn, "asc");

  let cursor: string | undefined;
  const seen: string[] = [];
  for (let i = 0; i < 10; i++) {
    const where = cursor
      ? buildCursorCondition(cursor, idColumn, sortColumn, "asc")
      : undefined;
    const page = db
      .select()
      .from(feed)
      .where(where)
      .orderBy(...orderBy)
      .limit(2)
      .all();

    if (page.length === 0) break;
    for (const row of page) {
      seen.push(row.id);
    }

    cursor = buildNextCursor(page, 2, "createdAt") ?? undefined;
    if (!cursor) break;
  }

  expect(seen).toEqual(["a", "b", "c", "d", "e"]);
  sqlite.close();
});
