import { expect, test } from "bun:test";
import { buildWithClause, MAX_RELATION_DEPTH } from "../crud/relations.ts";

test("buildWithClause returns undefined for undefined input", () => {
  expect(buildWithClause(undefined)).toBeUndefined();
});

test("buildWithClause returns undefined for empty array", () => {
  expect(buildWithClause([])).toBeUndefined();
});

test("buildWithClause returns clause for shallow relations", () => {
  const result = buildWithClause(["author", "tags"]);
  expect(result).toEqual({ author: true, tags: true });
});

test("buildWithClause allows relations up to max depth", () => {
  // depth 3 = exactly MAX_RELATION_DEPTH, should be included
  const rel = "a.b.c";
  const result = buildWithClause([rel]);
  expect(result).toEqual({ [rel]: true });
});

test("buildWithClause filters out relations exceeding max depth", () => {
  const tooDeep = "a.b.c.d"; // depth 4 > MAX_RELATION_DEPTH (3)
  const result = buildWithClause([tooDeep]);
  expect(result).toBeUndefined();
});

test("buildWithClause filters deep relations while keeping shallow ones", () => {
  const result = buildWithClause(["author", "a.b.c.d.e"]);
  expect(result).toEqual({ author: true });
});

test("buildWithClause respects custom maxDepth", () => {
  const result = buildWithClause(["a.b"], 1);
  expect(result).toBeUndefined();

  const result2 = buildWithClause(["a.b"], 2);
  expect(result2).toEqual({ "a.b": true });
});

test("MAX_RELATION_DEPTH is 3", () => {
  expect(MAX_RELATION_DEPTH).toBe(3);
});
