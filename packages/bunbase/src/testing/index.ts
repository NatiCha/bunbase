/**
 * BunBase testing utilities.
 *
 * Import from `@naticha/bunbase/testing` — not from the main `@naticha/bunbase` package, so
 * testing dependencies stay out of production builds.
 *
 * @module
 *
 * @example
 * ```ts
 * import { createTestServer } from "@naticha/bunbase/testing";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableName, is, Table } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DatabaseAdapter } from "../core/adapter.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { FieldPolicyMap } from "../core/field-policy.ts";
import { type CreateServerOptions, createServer } from "../core/server.ts";
import type { Hooks } from "../hooks/types.ts";
import type { Rules } from "../rules/types.ts";

/** An authenticated fetch bound to a seeded user's session cookie. */
export interface AuthedTestSession {
  /** The id of the seeded (or existing) user. */
  userId: string;
  /** The session id seeded into the `_sessions` table. */
  sessionId: string;
  /**
   * Like `server.fetch`, but additionally sends the session cookie for the
   * user this session belongs to, so authenticated routes work.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface TestServer {
  /** Base URL of the running server, e.g. `http://localhost:54321` */
  baseUrl: string;
  /**
   * Like `globalThis.fetch`, but with the baseUrl prepended and CSRF
   * cookie + header set automatically.  The `content-type` header defaults
   * to `application/json` when not provided.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Seed a user + active session directly into the database and return a fetch
   * bound to that session cookie (a per-session cookie jar). Use this for
   * authenticated-route tests — `server.fetch` alone carries no session.
   *
   * Accepts an email string (a user is created if none exists), or an options
   * object to control id / role / extra columns.
   *
   * SQLite-only (matches the rest of this helper).
   *
   * @example
   * ```ts
   * const alice = await server.loginAs("alice@example.com");
   * const res = await alice.fetch("/api/posts", { method: "POST", body: ... });
   * ```
   */
  loginAs(
    userOrEmail:
      | string
      | { id?: string; email?: string; role?: string; columns?: Record<string, unknown> },
  ): Promise<AuthedTestSession>;
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
  fields?: FieldPolicyMap;
  extend?: CreateServerOptions["extend"];
  /** Drizzle relations object (from `defineRelations`). */
  relations?: unknown;
  /** Optional config overrides (merged with test defaults). */
  config?: import("../core/config.ts").BunBaseConfig;
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
    fields: options.fields,
    extend: options.extend,
    relations: options.relations as any,
    config: {
      ...options.config,
      database: { driver: "sqlite", path: dbPath },
      migrationsPath: options.config?.migrationsPath ?? join(root, "drizzle"),
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
  const SESSION_COOKIE = "bunbase_session";

  // Locate the users table in the schema so loginAs can seed a user row.
  let usersTable: SQLiteTable | null = null;
  for (const value of Object.values(options.schema)) {
    if (is(value, Table) && getTableName(value as Table) === "users") {
      usersTable = value as SQLiteTable;
      break;
    }
  }

  function baseHeaders(init: RequestInit, extraCookies: string[] = []): Headers {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("x-csrf-token", csrfToken);
    const cookies = [`csrf_token=${csrfToken}`, ...extraCookies];
    headers.set("cookie", cookies.join("; "));
    return headers;
  }

  return {
    baseUrl,
    db: bunbase.db,
    adapter: bunbase.adapter,

    fetch(path: string, init: RequestInit = {}): Promise<Response> {
      return globalThis.fetch(`${baseUrl}${path}`, { ...init, headers: baseHeaders(init) });
    },

    async loginAs(
      userOrEmail:
        | string
        | { id?: string; email?: string; role?: string; columns?: Record<string, unknown> },
    ): Promise<AuthedTestSession> {
      const opts = typeof userOrEmail === "string" ? { email: userOrEmail } : userOrEmail;
      const userId = opts.id ?? `test-user-${Math.random().toString(36).slice(2)}`;
      const email = opts.email ?? `${userId}@example.com`;
      const role = opts.role ?? "user";

      if (usersTable) {
        const { columns } = getTableConfig(usersTable);
        // Provide sensible defaults for the standard user columns and fill any
        // other NOT NULL columns so the INSERT succeeds across template schemas.
        const provided: Record<string, unknown> = {
          id: userId,
          email,
          role,
          password_hash: "x",
          ...(opts.columns ?? {}),
        };
        const colNames: string[] = [];
        const values: string[] = [];
        for (const col of columns) {
          const name = col.name;
          let val = provided[name];
          if (val === undefined) {
            // Skip nullable/defaulted columns we don't know about.
            if (!col.notNull || col.hasDefault) continue;
            // Required column with no value — fill a placeholder by SQL type.
            val = col.getSQLType().toLowerCase().includes("int") ? 0 : "";
          }
          colNames.push(`"${name}"`);
          values.push(
            typeof val === "number" ? String(val) : `'${String(val).replace(/'/g, "''")}'`,
          );
        }
        await bunbase.adapter.rawExecute(
          `INSERT OR IGNORE INTO "users" (${colNames.join(", ")}) VALUES (${values.join(", ")})`,
        );
      }

      const sessionId = `test-session-${Math.random().toString(36).slice(2)}`;
      const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // +24h (seconds)
      const createdAt = new Date().toISOString();
      // mfa_verified left NULL = fully-authenticated session (not pending MFA).
      await bunbase.adapter.rawExecute(
        `INSERT INTO "_sessions" ("id", "user_id", "expires_at", "created_at") VALUES ('${sessionId}', '${userId}', ${expiresAt}, '${createdAt}')`,
      );

      const sessionCookie = `${SESSION_COOKIE}=${sessionId}`;
      return {
        userId,
        sessionId,
        fetch(path: string, init: RequestInit = {}): Promise<Response> {
          return globalThis.fetch(`${baseUrl}${path}`, {
            ...init,
            headers: baseHeaders(init, [sessionCookie]),
          });
        },
      };
    },

    cleanup(): void {
      server.stop();
      bunbase.adapter.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
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
