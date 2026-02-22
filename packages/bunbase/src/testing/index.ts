/**
 * BunBase testing utilities.
 *
 * Import from `bunbase/testing` — not from the main `bunbase` package, so
 * testing dependencies stay out of production builds.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createTestServer } from "bunbase/testing";
 * import { sqliteTable, text } from "drizzle-orm/sqlite-core";
 *
 * const posts = sqliteTable("posts", {
 *   id:    text("id").primaryKey(),
 *   title: text("title").notNull(),
 * });
 *
 * const server = await createTestServer({
 *   schema: { posts },
 *   rules: { posts: { list: () => true, create: ({ auth }) => auth !== null } },
 * });
 *
 * afterAll(() => server.cleanup());
 *
 * test("creates a post", async () => {
 *   const res = await server.fetch("/api/posts", {
 *     method: "POST",
 *     body: JSON.stringify({ id: "p1", title: "Hello" }),
 *   });
 *   expect(res.status).toBe(201);
 * });
 * ```
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { is, Table } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { createServer } from "../core/server.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { DatabaseAdapter } from "../core/adapter.ts";
import type { Rules } from "../rules/types.ts";
import type { Hooks } from "../hooks/types.ts";

export interface TestServer {
  /** Base URL of the running server, e.g. `http://localhost:54321` */
  baseUrl: string;
  /**
   * Like `globalThis.fetch`, but with the baseUrl prepended and CSRF
   * cookie + header set automatically.  The `content-type` header defaults
   * to `application/json` when not provided.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Drizzle db instance — use for direct seeding / assertions in tests. */
  db: AnyDb;
  /** Raw adapter — use for `rawExecute`, `rawQuery`, etc. */
  adapter: DatabaseAdapter;
  /** Stop the server, close the database, and remove the temp directory. */
  cleanup(): void;
}

export interface CreateTestServerOptions {
  schema: Record<string, unknown>;
  rules?: Rules;
  hooks?: Hooks;
  /** Drizzle relations object (from `defineRelations`). */
  relations?: unknown;
}

/**
 * Spin up a real BunBase server on a random port for use in tests.
 *
 * - User tables are created automatically from the Drizzle schema.
 * - Internal BunBase tables (_sessions, _files, etc.) are bootstrapped automatically.
 * - `server.fetch()` prepends the base URL and handles CSRF transparently.
 * - Call `server.cleanup()` in `afterAll` to stop the server and delete temp files.
 */
export async function createTestServer(options: CreateTestServerOptions): Promise<TestServer> {
  const root = join(tmpdir(), `bunbase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, "db.sqlite");

  const bunbase = createServer({
    schema: options.schema as Record<string, Table>,
    rules: options.rules,
    hooks: options.hooks,
    relations: options.relations as any,
    config: {
      database: { driver: "sqlite", path: dbPath },
      storage: { driver: "local", localPath: join(root, "uploads") },
      development: true,
    },
  });

  // Auto-create user tables from the schema using Drizzle column metadata.
  // Internal BunBase tables are handled by createServer's bootstrap flow.
  for (const value of Object.values(options.schema)) {
    if (is(value, Table)) {
      await bunbase.adapter.rawExecute(generateCreateTableSQL(value as SQLiteTable));
    }
  }

  const server = bunbase.listen(0);
  const baseUrl = String(server.url).replace(/\/$/, "");
  const csrfToken = "test-csrf-token";

  return {
    baseUrl,
    db: bunbase.db,
    adapter: bunbase.adapter,

    fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      headers.set("x-csrf-token", csrfToken);
      headers.set("cookie", `csrf_token=${csrfToken}`);
      return globalThis.fetch(`${baseUrl}${path}`, { ...init, headers });
    },

    cleanup(): void {
      server.stop();
      bunbase.adapter.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/**
 * Generate a SQLite CREATE TABLE statement from a Drizzle table definition.
 * Handles TEXT, INTEGER, REAL, BLOB columns, PRIMARY KEY, and NOT NULL.
 * Suitable for in-memory and file-based SQLite test databases.
 */
function generateCreateTableSQL(table: SQLiteTable): string {
  const { name, columns } = getTableConfig(table);
  const colDefs = columns.map((col) => {
    let def = `"${col.name}" ${col.getSQLType().toUpperCase()}`;
    if (col.primary) def += " PRIMARY KEY";
    else if (col.notNull) def += " NOT NULL";
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`;
}
