import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { buildWhereConditions } from "../crud/filters.ts";

const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  score: integer("score").notNull(),
  tag: text("tag"),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(
    "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, score INTEGER NOT NULL, tag TEXT)",
  );
  const db = drizzle({ client: sqlite });
  const rows = [
    { id: "1", name: "alpha", status: "active", score: 10, tag: "a" },
    { id: "2", name: "beta", status: "inactive", score: 20, tag: null },
    { id: "3", name: "gamma", status: "active", score: 30, tag: "b" },
    { id: "4", name: "alpha2", status: "active", score: 40, tag: "a" },
    { id: "5", name: "delta", status: "inactive", score: 50, tag: null },
  ];
  for (const row of rows) {
    sqlite
      .query(
        "INSERT INTO items (id, name, status, score, tag) VALUES ($id, $name, $status, $score, $tag)",
      )
      .run({
        $id: row.id,
        $name: row.name,
        $status: row.status,
        $score: row.score,
        $tag: row.tag ?? null,
      });
  }
  return { sqlite, db };
}

function query(db: ReturnType<typeof drizzle>, where: ReturnType<typeof buildWhereConditions>) {
  return db.select().from(items).where(where).all();
}

const cols = getColumns(items) as Record<string, SQLiteColumn>;

test("buildWhereConditions with no filters returns undefined", () => {
  expect(buildWhereConditions({}, cols)).toBeUndefined();
});

test("buildWhereConditions skips unknown column names", () => {
  const where = buildWhereConditions({ nonexistent: { eq: "x" } }, cols);
  expect(where).toBeUndefined();
});

test("eq operator: direct value shorthand", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ status: "active" }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["1", "3", "4"]);
  sqlite.close();
});

test("eq operator: explicit object form", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ score: { eq: 20 } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id)).toEqual(["2"]);
  sqlite.close();
});

test("ne operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ status: { ne: "active" } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["2", "5"]);
  sqlite.close();
});

test("gt operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ score: { gt: 30 } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["4", "5"]);
  sqlite.close();
});

test("gte operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ score: { gte: 30 } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["3", "4", "5"]);
  sqlite.close();
});

test("lt operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ score: { lt: 20 } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id)).toEqual(["1"]);
  sqlite.close();
});

test("lte operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ score: { lte: 20 } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["1", "2"]);
  sqlite.close();
});

test("contains operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ name: { contains: "lph" } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["1", "4"]);
  sqlite.close();
});

test("startsWith operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ name: { startsWith: "al" } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["1", "4"]);
  sqlite.close();
});

test("endsWith operator", () => {
  const { db, sqlite } = setupDb();
  // "alpha"(1), "beta"(2), "gamma"(3), "delta"(5) all end with "a"
  const where = buildWhereConditions({ name: { endsWith: "a" } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["1", "2", "3", "5"]);
  sqlite.close();
});

test("in operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ id: { in: ["1", "3", "5"] } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["1", "3", "5"]);
  sqlite.close();
});

test("notIn operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ id: { notIn: ["1", "2"] } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["3", "4", "5"]);
  sqlite.close();
});

test("isNull: true operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ tag: { isNull: true } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["2", "5"]);
  sqlite.close();
});

test("isNull: false operator", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ tag: { isNull: false } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["1", "3", "4"]);
  sqlite.close();
});

test("multiple operators combined (AND)", () => {
  const { db, sqlite } = setupDb();
  const where = buildWhereConditions({ status: "active", score: { gte: 30 } }, cols);
  const results = query(db, where);
  expect(results.map((r) => r.id).sort()).toEqual(["3", "4"]);
  sqlite.close();
});
