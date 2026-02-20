import { test, expect } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  validateUsersTable,
  getUserTableNames,
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

const internalTable = sqliteTable("_internal", {
  id: text("id").primaryKey(),
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

// validateUsersTable — exercises the getTableName catch block.
test("validateUsersTable skips plain objects that cause getTableName to throw", () => {
  const result = validateUsersTable({
    probablyNotATable: {} as any,
    users: validUsersTable,
  });
  expect(result).toBe(validUsersTable);
});

test("getUserTableNames skips plain objects that cause getTableName to throw", () => {
  const names = getUserTableNames({ notATable: {} as any, valid: validUsersTable });
  // validUsersTable is named "users"
  expect(names).toContain("users");
  expect(names).not.toContain("notATable");
});
