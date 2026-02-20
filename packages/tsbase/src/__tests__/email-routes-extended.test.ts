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

// Counter to ensure unique IPs across all tests in this file
let _ip = 0;
function freshIp(): string {
  return `10.20.${++_ip}.1`;
}

// ─── /auth/request-password-reset ───────────────────────────────────────────

test("request-password-reset returns 400 for invalid JSON", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/request-password-reset"].POST(
    new Request("http://localhost/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: "not-json",
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("request-password-reset returns 400 for invalid email", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/request-password-reset"].POST(
    new Request("http://localhost/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ email: "not-an-email" }),
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("request-password-reset returns 500 in production when webhook is not configured", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({
      development: false,
      cors: { origins: ["https://example.com"] },
    }),
    usersTable,
  });

  const response = await routes["/auth/request-password-reset"].POST(
    new Request("http://localhost/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ email: "reset@example.com" }),
    }),
  );
  expect(response.status).toBe(500);
  sqlite.close();
});

test("request-password-reset in dev mode logs token when no webhook configured", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(" "));

  try {
    const routes = createEmailRoutes({
      db,
      internalSchema,
      config: makeResolvedConfig({ development: true }),
      usersTable,
      // no email.webhook in config
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ email: "reset@example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    // Should have logged the token
    expect(logged.some((msg) => msg.includes("reset@example.com"))).toBe(true);
  } finally {
    console.log = originalLog;
    sqlite.close();
  }
});

test("request-password-reset returns 200 for non-existent email (user enumeration prevention)", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/request-password-reset"].POST(
    new Request("http://localhost/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ email: "nobody@example.com" }),
    }),
  );
  expect(response.status).toBe(200);
  sqlite.close();
});

test("request-password-reset returns 429 when rate limited", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });
  const ip = freshIp();

  // Exhaust the rate limit (11 requests for the same IP)
  for (let i = 0; i < 11; i++) {
    await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tsbase-socket-ip": ip },
        body: JSON.stringify({ email: "nobody@example.com" }),
      }),
    );
  }

  const blocked = await routes["/auth/request-password-reset"].POST(
    new Request("http://localhost/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tsbase-socket-ip": ip },
      body: JSON.stringify({ email: "nobody@example.com" }),
    }),
  );
  expect(blocked.status).toBe(429);
  sqlite.close();
});

// ─── /auth/reset-password ───────────────────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

test("reset-password returns 400 for invalid JSON", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/reset-password"].POST(
    new Request("http://localhost/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: "not-json",
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("reset-password returns 400 for invalid or expired token", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/reset-password"].POST(
    new Request("http://localhost/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ token: "no-such-token", password: "newpassword123" }),
    }),
  );
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("expired");
  sqlite.close();
});

test("reset-password succeeds and creates a new session", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();

  // Insert a valid token directly
  const token = "test-reset-token-abc";
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sqlite
    .query(
      "INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at) VALUES ($id, $userId, $tokenHash, $type, $expiresAt, $createdAt)",
    )
    .run({
      $id: "tok-1",
      $userId: "user-1",
      $tokenHash: tokenHash,
      $type: "password_reset",
      $expiresAt: expiresAt,
      $createdAt: new Date().toISOString(),
    });

  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/reset-password"].POST(
    new Request("http://localhost/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ token, password: "newpassword123" }),
    }),
  );
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(cookies.some((c) => c.startsWith("tsbase_session="))).toBe(true);

  // Token should be deleted
  const remaining = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _verification_tokens")
    .get([]);
  expect(remaining?.n).toBe(0);

  sqlite.close();
});

test("reset-password returns 400 for password too short", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/reset-password"].POST(
    new Request("http://localhost/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ token: "tok", password: "short" }),
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

// ─── /auth/verify-email ─────────────────────────────────────────────────────

test("verify-email returns 400 for invalid JSON", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/verify-email"].POST(
    new Request("http://localhost/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("verify-email returns 400 for missing token field", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/verify-email"].POST(
    new Request("http://localhost/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("verify-email returns 400 for invalid or expired token", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/verify-email"].POST(
    new Request("http://localhost/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invalid-token" }),
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("verify-email succeeds with valid token", async () => {
  const { sqlite, db, internalSchema } = setupEmailDb();
  // Add email_verified column to support the update
  try {
    sqlite.run("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  } catch { /* already exists */ }

  const token = "email-verify-token";
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sqlite
    .query(
      "INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at) VALUES ($id, $userId, $tokenHash, $type, $expiresAt, $createdAt)",
    )
    .run({
      $id: "vtok-1",
      $userId: "user-1",
      $tokenHash: tokenHash,
      $type: "email_verification",
      $expiresAt: expiresAt,
      $createdAt: new Date().toISOString(),
    });

  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/verify-email"].POST(
    new Request("http://localhost/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.json() as { message: string };
  expect(body.message).toContain("verified");

  // Token should be deleted
  const remaining = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _verification_tokens")
    .get([]);
  expect(remaining?.n).toBe(0);

  sqlite.close();
});
