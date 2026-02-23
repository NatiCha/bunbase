import { expect, test } from "bun:test";
import { buildNextCursor, decodeCursor, encodeCursor, resolveLimit } from "../crud/pagination.ts";

// encodeCursor / decodeCursor

test("encodeCursor and decodeCursor round-trip with id only", () => {
  const encoded = encodeCursor({ id: "abc123" });
  const decoded = decodeCursor(encoded);
  expect(decoded).toEqual({ id: "abc123", sortValue: undefined });
});

test("encodeCursor and decodeCursor round-trip with sortValue", () => {
  const encoded = encodeCursor({ id: "x1", sortValue: 42 });
  const decoded = decodeCursor(encoded);
  expect(decoded).toEqual({ id: "x1", sortValue: 42 });
});

test("decodeCursor returns null for invalid base64", () => {
  const result = decodeCursor("not-valid-base64!!!");
  expect(result).toBeNull();
});

test("decodeCursor returns null when id field is missing", () => {
  const bad = btoa(JSON.stringify({ sortValue: 5 }));
  const result = decodeCursor(bad);
  expect(result).toBeNull();
});

test("decodeCursor returns null when id is not a string", () => {
  const bad = btoa(JSON.stringify({ id: 99 }));
  const result = decodeCursor(bad);
  expect(result).toBeNull();
});

test("decodeCursor returns null for empty string", () => {
  const result = decodeCursor("");
  expect(result).toBeNull();
});

// resolveLimit

test("resolveLimit returns default 20 when no value provided", () => {
  expect(resolveLimit(undefined)).toBe(20);
});

test("resolveLimit returns default 20 for zero", () => {
  expect(resolveLimit(0)).toBe(20);
});

test("resolveLimit returns default 20 for negative", () => {
  expect(resolveLimit(-5)).toBe(20);
});

test("resolveLimit returns the provided value when valid", () => {
  expect(resolveLimit(50)).toBe(50);
});

test("resolveLimit caps at 100", () => {
  expect(resolveLimit(999)).toBe(100);
  expect(resolveLimit(100)).toBe(100);
});

// buildNextCursor

test("buildNextCursor returns null when items fewer than limit", () => {
  const items = [{ id: "a" }, { id: "b" }];
  expect(buildNextCursor(items, 5)).toBeNull();
});

test("buildNextCursor returns null for empty array", () => {
  expect(buildNextCursor([], 10)).toBeNull();
});

test("buildNextCursor returns cursor when items equal limit (id only)", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const cursor = buildNextCursor(items, 3);
  expect(cursor).not.toBeNull();
  const decoded = decodeCursor(cursor!);
  expect(decoded?.id).toBe("c");
  expect(decoded?.sortValue).toBeUndefined();
});

test("buildNextCursor includes sortValue when sortField provided", () => {
  const items = [
    { id: "x", createdAt: 100 },
    { id: "y", createdAt: 200 },
  ];
  const cursor = buildNextCursor(items, 2, "createdAt");
  expect(cursor).not.toBeNull();
  const decoded = decodeCursor(cursor!);
  expect(decoded?.id).toBe("y");
  expect(decoded?.sortValue).toBe(200);
});

test("buildNextCursor omits sortValue when sortField is 'id'", () => {
  const items = [{ id: "p" }, { id: "q" }];
  const cursor = buildNextCursor(items, 2, "id");
  expect(cursor).not.toBeNull();
  const decoded = decodeCursor(cursor!);
  expect(decoded?.id).toBe("q");
  expect(decoded?.sortValue).toBeUndefined();
});
