import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { createEmailRoutes } from "../auth/email.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull(),
});

function setupEmailDb() {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL
    )
  `);
  sqlite
    .query(
      "INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $passwordHash, $role)",
    )
    .run({
      $id: "user-1",
      $email: "reset@example.com",
      $passwordHash: "hash",
      $role: "user",
    });
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, internalSchema };
}

test("password reset posts webhook payload when configured", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const calls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init?.body ?? ""),
    });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const routes = createEmailRoutes({
      db,
      internalSchema,
      config: makeResolvedConfig({
        auth: {
          tokenExpiry: 3600,
          email: { webhook: "https://example.com/send-email" },
        },
      }),
      usersTable,
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.1",
        },
        body: JSON.stringify({ email: "reset@example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://example.com/send-email");
    expect(calls[0]?.body.includes("\"type\":\"password_reset\"")).toBe(true);
    expect(calls[0]?.body.includes("\"email\":\"reset@example.com\"")).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("password reset returns server error when webhook fails", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("bad", { status: 500 })) as unknown as typeof fetch;

  try {
    const routes = createEmailRoutes({
      db,
      internalSchema,
      config: makeResolvedConfig({
        auth: {
          tokenExpiry: 3600,
          email: { webhook: "https://example.com/send-email" },
        },
      }),
      usersTable,
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.2",
        },
        body: JSON.stringify({ email: "reset@example.com" }),
      }),
    );

    expect(response.status).toBe(500);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
