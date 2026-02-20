import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import {
  authenticated,
  admin,
  ownerOnly,
  adminOrOwner,
  allowAll,
  isSet,
  isChanged,
  fieldLength,
  collection,
  now,
  todayStart,
  todayEnd,
  monthStart,
  yearStart,
} from "../rules/helpers.ts";

const authUser = { id: "u1", email: "u1@example.com", role: "user" as const };
const adminUser = { id: "u2", email: "u2@example.com", role: "admin" as const };

// ─── authenticated ───────────────────────────────────────────────────────────

test("authenticated returns false for null auth", () => {
  expect(authenticated(null)).toBe(false);
});

test("authenticated returns true for any user", () => {
  expect(authenticated(authUser)).toBe(true);
  expect(authenticated(adminUser)).toBe(true);
});

// ─── admin ───────────────────────────────────────────────────────────────────

test("admin returns false for null auth", () => {
  expect(admin(null)).toBe(false);
});

test("admin returns false for non-admin user", () => {
  expect(admin(authUser)).toBe(false);
});

test("admin returns true for admin user", () => {
  expect(admin(adminUser)).toBe(true);
});

// ─── ownerOnly ───────────────────────────────────────────────────────────────

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull(),
});

test("ownerOnly returns false for null auth", () => {
  expect(ownerOnly(posts.authorId, null)).toBe(false);
});

test("ownerOnly returns SQL clause for authenticated user", () => {
  const result = ownerOnly(posts.authorId, authUser);
  // Should be an SQL expression (truthy, not a boolean)
  expect(typeof result).not.toBe("boolean");
  expect(result).toBeTruthy();
});

// ─── adminOrOwner ────────────────────────────────────────────────────────────

test("adminOrOwner returns false for null auth", () => {
  expect(adminOrOwner(posts.authorId, null)).toBe(false);
});

test("adminOrOwner returns true for admin user", () => {
  expect(adminOrOwner(posts.authorId, adminUser)).toBe(true);
});

test("adminOrOwner returns SQL clause for non-admin user", () => {
  const result = adminOrOwner(posts.authorId, authUser);
  expect(typeof result).not.toBe("boolean");
  expect(result).toBeTruthy();
});

// ─── allowAll ────────────────────────────────────────────────────────────────

test("allowAll permits all operations (returns null)", async () => {
  const arg = { auth: null, body: {}, headers: {}, query: {}, method: "GET", db: {} as any };
  expect(await allowAll.list!(arg)).toBeNull();
  expect(await allowAll.get!(arg)).toBeNull();
  expect(await allowAll.create!(arg)).toBeNull();
  expect(await allowAll.update!(arg)).toBeNull();
  expect(await allowAll.delete!(arg)).toBeNull();
});

// ─── isSet ───────────────────────────────────────────────────────────────────

test("isSet returns true when field is in body", () => {
  expect(isSet({ role: "admin" }, "role")).toBe(true);
  expect(isSet({ role: undefined }, "role")).toBe(true); // key present even if undefined
});

test("isSet returns false when field is not in body", () => {
  expect(isSet({ title: "hi" }, "role")).toBe(false);
  expect(isSet({}, "anything")).toBe(false);
});

// ─── isChanged ───────────────────────────────────────────────────────────────

test("isChanged returns false when field not in body", () => {
  expect(isChanged({ title: "new" }, { author: "u1" }, "author")).toBe(false);
});

test("isChanged returns true when record is undefined (no existing state)", () => {
  expect(isChanged({ author: "u2" }, undefined, "author")).toBe(true);
});

test("isChanged returns true when value differs from record", () => {
  expect(isChanged({ author: "u2" }, { author: "u1" }, "author")).toBe(true);
});

test("isChanged returns false when value matches record", () => {
  expect(isChanged({ author: "u1" }, { author: "u1" }, "author")).toBe(false);
});

// ─── fieldLength ─────────────────────────────────────────────────────────────

test("fieldLength returns 0 when record is undefined", () => {
  expect(fieldLength(undefined, "tags")).toBe(0);
});

test("fieldLength returns 0 when field is not an array", () => {
  expect(fieldLength({ tags: "not-an-array" }, "tags")).toBe(0);
  expect(fieldLength({ tags: null }, "tags")).toBe(0);
});

test("fieldLength returns array length", () => {
  expect(fieldLength({ tags: ["a", "b", "c"] }, "tags")).toBe(3);
  expect(fieldLength({ tags: [] }, "tags")).toBe(0);
});

// ─── collection ──────────────────────────────────────────────────────────────

test("collection queries the database and returns matching rows", async () => {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL)");
  sqlite.run("INSERT INTO posts VALUES ('p1', 'u1')");
  sqlite.run("INSERT INTO posts VALUES ('p2', 'u2')");
  const db = drizzle({ client: sqlite });

  const results = await collection(db as any, posts as any, eq(posts.authorId, "u1"));
  expect(results).toHaveLength(1);
  expect((results[0] as any).id).toBe("p1");
  sqlite.close();
});

// ─── date helpers ────────────────────────────────────────────────────────────

test("now() returns a Date close to current time", () => {
  const before = Date.now();
  const result = now();
  const after = Date.now();
  expect(result).toBeInstanceOf(Date);
  expect(result.getTime()).toBeGreaterThanOrEqual(before);
  expect(result.getTime()).toBeLessThanOrEqual(after);
});

test("todayStart() returns midnight today", () => {
  const result = todayStart();
  expect(result).toBeInstanceOf(Date);
  expect(result.getHours()).toBe(0);
  expect(result.getMinutes()).toBe(0);
  expect(result.getSeconds()).toBe(0);
  expect(result.getMilliseconds()).toBe(0);
  // Same date as today
  const today = new Date();
  expect(result.getFullYear()).toBe(today.getFullYear());
  expect(result.getMonth()).toBe(today.getMonth());
  expect(result.getDate()).toBe(today.getDate());
});

test("todayEnd() returns end of today (23:59:59.999)", () => {
  const result = todayEnd();
  expect(result).toBeInstanceOf(Date);
  expect(result.getHours()).toBe(23);
  expect(result.getMinutes()).toBe(59);
  expect(result.getSeconds()).toBe(59);
  expect(result.getMilliseconds()).toBe(999);
});

test("monthStart() returns first day of month at midnight", () => {
  const result = monthStart();
  expect(result).toBeInstanceOf(Date);
  expect(result.getDate()).toBe(1);
  expect(result.getHours()).toBe(0);
  const today = new Date();
  expect(result.getFullYear()).toBe(today.getFullYear());
  expect(result.getMonth()).toBe(today.getMonth());
});

test("yearStart() returns January 1 at midnight", () => {
  const result = yearStart();
  expect(result).toBeInstanceOf(Date);
  expect(result.getMonth()).toBe(0);
  expect(result.getDate()).toBe(1);
  expect(result.getHours()).toBe(0);
  expect(result.getFullYear()).toBe(new Date().getFullYear());
});
