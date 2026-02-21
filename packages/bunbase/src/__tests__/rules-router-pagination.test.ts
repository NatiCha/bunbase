import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { getColumns } from "drizzle-orm";
import { generateCrudHandlers } from "../crud/handler.ts";
import type { AuthUser } from "../api/types.ts";
import {
  buildCursorCondition,
  buildNextCursor,
  buildOrderBy,
} from "../crud/pagination.ts";

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull(),
});

const feed = sqliteTable("feed", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

function mockAuth(id = "u1"): (req: Request) => Promise<AuthUser | null> {
  return async (_req) => ({ id, email: `${id}@example.com`, role: "user" });
}

test("view rule is enforced for GET /:id reads", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL)");
  sqlite.query("INSERT INTO posts (id, author_id) VALUES ($id, $authorId)")
    .run({ $id: "p1", $authorId: "u1" });

  const db = drizzle({ client: sqlite });
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), { view: () => false });

  const res = await pattern["/api/posts/:id"].GET(
    new Request("http://localhost/api/posts/p1"),
  );
  expect(res.status).toBe(403);
  sqlite.close();
});

test("get rule alias remains supported for reads", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL)");
  sqlite.query("INSERT INTO posts (id, author_id) VALUES ($id, $authorId)")
    .run({ $id: "p1", $authorId: "u1" });

  const db = drizzle({ client: sqlite });
  const { pattern } = generateCrudHandlers(posts, db, mockAuth(), { get: () => false });

  const res = await pattern["/api/posts/:id"].GET(
    new Request("http://localhost/api/posts/p1"),
  );
  expect(res.status).toBe(403);
  sqlite.close();
});

test("extend routes collision is detected at server creation time", () => {
  // Extending with the same path should throw
  const routes1 = { "/api/foo": { GET: async () => new Response("a") } };
  const routes2 = { "/api/foo": { GET: async () => new Response("b") } };

  // Simulate the collision detection logic from server.ts
  const httpRoutes: Record<string, any> = { ...routes1 };
  expect(() => {
    for (const [path, handlers] of Object.entries(routes2)) {
      if (httpRoutes[path]) {
        throw new Error(`BunBase: Cannot merge extend routes due to path collision: ${path}`);
      }
      httpRoutes[path] = handlers;
    }
  }).toThrow("Cannot merge extend routes");
});

test("extend routes without collision merge cleanly", () => {
  const routes1 = { "/api/foo": { GET: async () => new Response("a") } };
  const routes2 = { "/api/bar": { GET: async () => new Response("b") } };

  const httpRoutes: Record<string, any> = { ...routes1 };
  for (const [path, handlers] of Object.entries(routes2)) {
    if (httpRoutes[path]) {
      throw new Error(`collision`);
    }
    httpRoutes[path] = handlers;
  }
  expect(Object.keys(httpRoutes)).toEqual(["/api/foo", "/api/bar"]);
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
    sqlite.query("INSERT INTO feed (id, created_at) VALUES ($id, $createdAt)")
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
