/**
 * Integration tests for lifecycle hooks — real HTTP server on port 0.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../core/server.ts";
import { ApiError } from "../api/helpers.ts";
import { defineHooks } from "../hooks/types.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const root = join(tmpdir(), `bunbase-hooks-intg-${Date.now()}`);
mkdirSync(root, { recursive: true });

const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tag: text("tag"),
});

// ── Test 1: POST with beforeCreate hook modifying data ───────────────────────

let serverModify: ReturnType<typeof Bun.serve>;
let baseModify: string;
let bunbaseModify: ReturnType<typeof createServer>;

beforeAll(async () => {
  const dbPath = join(root, "db-modify.sqlite");

  bunbaseModify = createServer({
    schema: { items },
    rules: {
      items: { list: () => null, view: () => null, get: () => null, create: () => null, update: () => null, delete: () => null },
    },
    hooks: defineHooks({
      items: {
        beforeCreate: ({ data }) => ({ ...data, tag: "auto-tagged" }),
      },
    }),
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPath },
      dbPath,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-modify"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-modify"),
    }),
  });

  await bunbaseModify.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT)",
  );

  serverModify = bunbaseModify.listen(0);
  baseModify = serverModify.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  serverModify?.stop();
  bunbaseModify?.adapter.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("POST with beforeCreate hook modifying data — tag is auto-set in response", async () => {
  const csrfToken = "test-csrf-token";
  const res = await fetch(`${baseModify}/api/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
      "cookie": `csrf_token=${csrfToken}`,
    },
    body: JSON.stringify({ id: "i1", name: "Widget" }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as any;
  expect(body.tag).toBe("auto-tagged");
  expect(body.name).toBe("Widget");
});

// ── Test 2: DELETE with beforeDelete hook throwing ApiError(403) ─────────────

let serverBlock: ReturnType<typeof Bun.serve>;
let baseBlock: string;
let bunbaseBlock: ReturnType<typeof createServer>;

beforeAll(async () => {
  const dbPath2 = join(root, "db-block.sqlite");

  bunbaseBlock = createServer({
    schema: { items },
    rules: {
      items: { list: () => null, view: () => null, get: () => null, create: () => null, update: () => null, delete: () => null },
    },
    hooks: defineHooks({
      items: {
        beforeDelete: ({ record }) => {
          if (record.tag === "protected") {
            throw new ApiError("FORBIDDEN", "Cannot delete protected items", 403);
          }
        },
      },
    }),
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPath2 },
      dbPath: dbPath2,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-block"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-block"),
    }),
  });

  await bunbaseBlock.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT)",
  );
  await bunbaseBlock.adapter.rawExecute(
    "INSERT INTO items (id, name, tag) VALUES ('protected-1', 'Critical Item', 'protected')",
  );
  await bunbaseBlock.adapter.rawExecute(
    "INSERT INTO items (id, name, tag) VALUES ('normal-1', 'Normal Item', 'normal')",
  );

  serverBlock = bunbaseBlock.listen(0);
  baseBlock = serverBlock.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  serverBlock?.stop();
  bunbaseBlock?.adapter.close();
});

test("DELETE with beforeDelete hook throwing ApiError(403) — returns 403 response", async () => {
  const csrfToken = "test-csrf-delete";
  const res = await fetch(`${baseBlock}/api/items/protected-1`, {
    method: "DELETE",
    headers: {
      "x-csrf-token": csrfToken,
      "cookie": `csrf_token=${csrfToken}`,
    },
  });
  expect(res.status).toBe(403);
  const body = await res.json() as any;
  expect(body.error.code).toBe("FORBIDDEN");
  expect(body.error.message).toBe("Cannot delete protected items");
});

test("DELETE with beforeDelete hook allows deletion of non-protected items", async () => {
  const csrfToken = "test-csrf-delete-ok";
  const res = await fetch(`${baseBlock}/api/items/normal-1`, {
    method: "DELETE",
    headers: {
      "x-csrf-token": csrfToken,
      "cookie": `csrf_token=${csrfToken}`,
    },
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.deleted).toBe(true);
});
