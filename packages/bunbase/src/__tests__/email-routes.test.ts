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

test("password reset returns 200 even when webhook fails (BB-AUTH-002: no enumeration oracle)", async () => {
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

    // Must always return 200 — webhook failures must not leak account existence
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.message).toContain("If an account");
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("reset-password revokes all API keys for user (BB-APIKEY-004)", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();

  // Seed a raw token so we can test the reset flow directly
  const rawToken = "test-reset-token-abcdef1234567890";
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  sqlite.run(
    "INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["tok-1", "user-1", tokenHash, "password_reset", expiresAt, new Date().toISOString()],
  );

  // Seed an API key for the user
  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
    ["key-1", "user-1", "somekeyhash", "bb_live_ab", "Test Key", new Date().toISOString()],
  );

  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/reset-password"].POST(
    new Request("http://localhost/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawToken, password: "newpassword123" }),
    }),
  );

  expect(response.status).toBe(200);

  // API key must be deleted
  const keyRow = sqlite.query("SELECT id FROM _api_keys WHERE user_id = 'user-1'").get() as any;
  expect(keyRow).toBeNull();
});
