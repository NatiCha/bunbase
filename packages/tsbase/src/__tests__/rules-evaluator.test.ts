import { test, expect } from "bun:test";
import { sql } from "drizzle-orm";
import {
  evaluateRule,
  isAuthenticated,
  isAdmin,
} from "../rules/evaluator.ts";
import type { RuleContext } from "../rules/types.ts";

const authUser = { id: "u1", email: "u1@example.com", role: "user" as const };
const adminUser = { id: "u2", email: "u2@example.com", role: "admin" as const };

const ctxNoAuth: RuleContext = { auth: null };
const ctxUser: RuleContext = { auth: authUser };
const ctxAdmin: RuleContext = { auth: adminUser };

// evaluateRule

test("evaluateRule with no rule defined denies by default", async () => {
  const result = await evaluateRule(undefined, ctxNoAuth);
  expect(result.allowed).toBe(false);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with rule returning null allows all", async () => {
  const result = await evaluateRule(() => null, ctxUser);
  expect(result.allowed).toBe(true);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with rule returning true allows", async () => {
  const result = await evaluateRule(() => true, ctxUser);
  expect(result.allowed).toBe(true);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with rule returning false denies", async () => {
  const result = await evaluateRule(() => false, ctxNoAuth);
  expect(result.allowed).toBe(false);
  expect(result.whereClause).toBeUndefined();
});

test("evaluateRule with async rule works correctly", async () => {
  const result = await evaluateRule(async () => false, ctxUser);
  expect(result.allowed).toBe(false);
});

test("evaluateRule with SQL clause allows and attaches whereClause", async () => {
  const clause = sql`1 = 1`;
  const result = await evaluateRule(() => clause, ctxUser);
  expect(result.allowed).toBe(true);
  expect(result.whereClause).toBe(clause);
});

// isAuthenticated

test("isAuthenticated returns false when auth is null", () => {
  expect(isAuthenticated(ctxNoAuth)).toBe(false);
});

test("isAuthenticated returns true when auth is present", () => {
  expect(isAuthenticated(ctxUser)).toBe(true);
  expect(isAuthenticated(ctxAdmin)).toBe(true);
});

// isAdmin

test("isAdmin returns false when auth is null", () => {
  expect(isAdmin(ctxNoAuth)).toBe(false);
});

test("isAdmin returns false for non-admin user", () => {
  expect(isAdmin(ctxUser)).toBe(false);
});

test("isAdmin returns true for admin user", () => {
  expect(isAdmin(ctxAdmin)).toBe(true);
});
