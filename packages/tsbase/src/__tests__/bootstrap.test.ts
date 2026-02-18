import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import {
  validateUsersTable,
  createUserTables,
  getUserTableNames,
  injectTimestampColumns,
} from "../core/bootstrap.ts";

// validateUsersTable

const validUsersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});

const incompleteUsersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  // missing passwordHash and role
});

const nonUsersTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

test("validateUsersTable returns the table when all required columns are present", () => {
  const result = validateUsersTable({ users: validUsersTable });
  expect(result).toBe(validUsersTable);
});

test("validateUsersTable returns null when no users table in schema", () => {
  const result = validateUsersTable({ posts: nonUsersTable });
  expect(result).toBeNull();
});

test("validateUsersTable returns null for empty schema", () => {
  const result = validateUsersTable({});
  expect(result).toBeNull();
});

test("validateUsersTable throws when required columns are missing", () => {
  expect(() => validateUsersTable({ users: incompleteUsersTable })).toThrow(
    "users table is missing required columns",
  );
});

test("validateUsersTable error message mentions passwordHash mapping", () => {
  const tableWithoutHash = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    // missing passwordHash
  });
  expect(() => validateUsersTable({ users: tableWithoutHash })).toThrow(
    "password_hash (passwordHash)",
  );
});

test("validateUsersTable skips non-object entries in schema", () => {
  const result = validateUsersTable({
    someString: "not a table",
    someNull: null,
    users: validUsersTable,
  });
  expect(result).toBe(validUsersTable);
});

// createUserTables

const mixedTypesTable = sqliteTable("mixed", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  count: integer("count").notNull().default(0),
  score: real("score"),
  status: text("status").notNull().default("active"),
});

const internalTable = sqliteTable("_internal", {
  id: text("id").primaryKey(),
});

test("createUserTables creates the table in SQLite", () => {
  const sqlite = new Database(":memory:");
  createUserTables(sqlite, { mixed: mixedTypesTable });

  // Should be able to insert a row
  sqlite
    .query(
      `INSERT INTO "mixed" (id, label, count, score, status) VALUES ($id, $label, $count, $score, $status)`,
    )
    .run({ $id: "1", $label: "test", $count: 42, $score: 3.14, $status: "ok" });

  const row = sqlite
    .query<{ label: string }, []>(`SELECT label FROM "mixed" LIMIT 1`)
    .get([]);
  expect(row?.label).toBe("test");
  sqlite.close();
});

test("createUserTables skips tables whose names start with '_'", () => {
  const sqlite = new Database(":memory:");
  createUserTables(sqlite, { _internal: internalTable });

  const tables = sqlite
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_internal'`,
    )
    .all([]);
  expect(tables).toHaveLength(0);
  sqlite.close();
});

test("createUserTables skips non-object schema entries", () => {
  const sqlite = new Database(":memory:");
  // Should not throw
  createUserTables(sqlite, { notATable: "string", nullEntry: null as any });
  sqlite.close();
});

// getUserTableNames

test("getUserTableNames returns only non-internal table names", () => {
  const names = getUserTableNames({
    users: validUsersTable,
    posts: nonUsersTable,
    _sessions: internalTable,
  });
  expect(names.sort()).toEqual(["posts", "users"]);
});

test("getUserTableNames returns empty array for empty schema", () => {
  expect(getUserTableNames({})).toEqual([]);
});

// injectTimestampColumns

test("injectTimestampColumns adds created_at and updated_at", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE items (id TEXT PRIMARY KEY)");
  injectTimestampColumns(sqlite, ["items"]);

  const cols = sqlite
    .query<{ name: string }, []>("PRAGMA table_info(items)")
    .all([])
    .map((c) => c.name);
  expect(cols).toContain("created_at");
  expect(cols).toContain("updated_at");
  sqlite.close();
});

test("injectTimestampColumns is idempotent (no error on second call)", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE things (id TEXT PRIMARY KEY)");
  injectTimestampColumns(sqlite, ["things"]);
  expect(() => injectTimestampColumns(sqlite, ["things"])).not.toThrow();
  sqlite.close();
});
