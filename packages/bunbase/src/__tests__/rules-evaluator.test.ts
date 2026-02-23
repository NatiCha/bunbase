import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { evaluateRule, isAdmin, isAuthenticated } from "../rules/evaluator.ts";
import type { RuleArg } from "../rules/types.ts";

const authUser = { id: "u1", email: "u1@example.com", role: "user" as const };
const adminUser = { id: "u2", email: "u2@example.com", role: "admin" as const };

const baseArg = { body: {}, headers: {}, query: {}, method: "GET", db: {} as any };

const argNoAuth: RuleArg = { ...baseArg, auth: null };
const argUser: RuleArg = { ...baseArg, auth: authUser };
const argAdmin: RuleArg = { ...baseArg, auth: adminUser };

// evaluateRule

test("evaluateRule with no rule defined denies by default", async () => {
  const result = await evaluateRule(undefined, argNoAuth);
  expect(result.allowed).toBe(false);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with rule returning null allows all", async () => {
  const result = await evaluateRule(() => null, argUser);
  expect(result.allowed).toBe(true);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with rule returning true allows", async () => {
  const result = await evaluateRule(() => true, argUser);
  expect(result.allowed).toBe(true);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with rule returning false denies", async () => {
  const result = await evaluateRule(() => false, argNoAuth);
  expect(result.allowed).toBe(false);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with async rule works correctly", async () => {
  const result = await evaluateRule(async () => false, argUser);
  expect(result.allowed).toBe(false);
});

test("evaluateRule with SQL clause allows and attaches whereClause", async () => {
  const clause = sql`1 = 1`;
  const result = await evaluateRule(() => clause, argUser);
  expect(result.allowed).toBe(true);
  expect(result.whereClause).toBe(clause);
});

test("evaluateRule passes full RuleArg to rule function", async () => {
  const captured: RuleArg[] = [];
  const arg: RuleArg = {
    auth: authUser,
    id: "r1",
    record: { title: "old" },
    body: { title: "new" },
    headers: { "x-custom": "val" },
    query: { foo: "bar" },
    method: "PATCH",
    db: {} as any,
  };
  await evaluateRule((a) => {
    captured.push(a);
    return true;
  }, arg);
  expect(captured[0]!).toBe(arg);
  expect(captured[0]!.record).toEqual({ title: "old" });
  expect(captured[0]!.body).toEqual({ title: "new" });
  expect(captured[0]!.method).toBe("PATCH");
});

// isAuthenticated

test("isAuthenticated returns false when auth is null", () => {
  expect(isAuthenticated(argNoAuth)).toBe(false);
});

test("isAuthenticated returns true when auth is present", () => {
  expect(isAuthenticated(argUser)).toBe(true);
  expect(isAuthenticated(argAdmin)).toBe(true);
});

// isAdmin

test("isAdmin returns false when auth is null", () => {
  expect(isAdmin(argNoAuth)).toBe(false);
});

test("isAdmin returns false for non-admin user", () => {
  expect(isAdmin(argUser)).toBe(false);
});

test("isAdmin returns true for admin user", () => {
  expect(isAdmin(argAdmin)).toBe(true);
});
