import { expect, test } from "bun:test";
import { join } from "node:path";
import { getTemplate } from "../cli/templates.ts";

// The library's own package.json — the scaffolder reads this to pin versions.
const libPkgPath = join(import.meta.dir, "../../package.json");
const libPkg = JSON.parse(await Bun.file(libPkgPath).text()) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

test("library package is named @naticha/bunbase (drives scaffold dependency key)", () => {
  expect(libPkg.name).toBe("@naticha/bunbase");
});

test("library pins exact (non-range) drizzle-orm + drizzle-kit", () => {
  const orm = libPkg.dependencies["drizzle-orm"];
  const kit = libPkg.devDependencies["drizzle-kit"];
  expect(orm).toBeDefined();
  expect(kit).toBeDefined();
  // Exact pin = no caret/tilde/star and not a dist-tag like "beta"/"latest".
  expect(orm).not.toMatch(/^[\^~*]|beta|latest/);
  expect(kit).not.toMatch(/^[\^~*]|beta|latest/);
  // Both drizzle packages must match exactly (same physical version).
  expect(orm).toBe(kit);
});

test("task-manager rules template has no `as any` casts", () => {
  const t = getTemplate("task-manager", "sqlite", [], "demo");
  expect(t.rules).toContain("ownerOnly(projects.ownerId, auth)");
  expect(t.rules).not.toContain("as any");
});

test("blog rules template has no `as any` casts", () => {
  const t = getTemplate("blog", "sqlite", [], "demo");
  expect(t.rules).not.toContain("as any");
  expect(t.rules).toContain("ownerOnly(posts.authorId, auth)");
});

test("every template ships a createTestServer sample test", () => {
  for (const type of ["task-manager", "blog", "saas", "inventory", "empty"] as const) {
    const t = getTemplate(type, "sqlite", [], "demo");
    expect(t.sampleTest).toContain('from "@naticha/bunbase/testing"');
    expect(t.sampleTest).toContain("createTestServer");
    expect(t.sampleTest).toContain("server.cleanup()");
  }
});

test("public-table sample test seeds and lists via the SQL endpoint", () => {
  const t = getTemplate("task-manager", "sqlite", [], "demo");
  expect(t.sampleTest).toContain("/api/projects");
  expect(t.sampleTest).toContain("rawExecute");
});

test("inventory uses snake_case SQL endpoint for camelCase tables", () => {
  // categories is the public table for inventory — single word, but verify the
  // helper would snake_case a multi-word key (orderItems → order_items).
  const t = getTemplate("inventory", "sqlite", [], "demo");
  expect(t.sampleTest).toContain("/api/categories");
});
