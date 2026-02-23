/**
 * Tests for auth event hooks — uses direct route handler calls (unit-style).
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { ApiError } from "../api/helpers.ts";
import { createEmailRoutes } from "../auth/email.ts";
import { createAuthRoutes } from "../auth/routes.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { defineAuthHooks } from "../hooks/auth-types.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

// Each test uses a unique x-forwarded-for IP so the shared rate-limit store
// does not leak between tests running in the same Bun worker.
let _ipSuffix = 0;
function freshIp() {
  return `10.100.${Math.floor(++_ipSuffix / 256)}.${_ipSuffix % 256}`;
}
function makeReq(url: string, opts: RequestInit = {}, ip?: string): Request {
  const headers = new Headers(opts.headers ?? {});
  headers.set("Content-Type", "application/json");
  headers.set("x-forwarded-for", ip ?? freshIp());
  return new Request(url, { ...opts, headers });
}

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  tier: text("tier"),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      tier TEXT
    )
  `);
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, internalSchema, adapter };
}

// ── beforeRegister ────────────────────────────────────────────────────────────

test("beforeRegister can modify insert data", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      beforeRegister: ({ data }) => ({ ...data, tier: "premium" }),
    }),
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "alice@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(201);
  const row = sqlite.query("SELECT tier FROM users WHERE email = 'alice@example.com'").get() as any;
  expect(row?.tier).toBe("premium");
  sqlite.close();
});

test("beforeRegister returning void uses original data", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  let called = false;
  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      beforeRegister: () => {
        called = true;
      },
    }),
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "bob@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(201);
  expect(called).toBe(true);
  const row = sqlite.query("SELECT email FROM users WHERE email = 'bob@example.com'").get() as any;
  expect(row?.email).toBe("bob@example.com");
  sqlite.close();
});

test("beforeRegister throwing ApiError aborts registration", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      beforeRegister: ({ email }) => {
        if (!email.endsWith("@company.com")) {
          throw new ApiError("FORBIDDEN", "Domain not allowed", 403);
        }
      },
    }),
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "outsider@gmail.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("FORBIDDEN");
  expect(body.error.message).toBe("Domain not allowed");

  const row = sqlite.query("SELECT id FROM users WHERE email = 'outsider@gmail.com'").get();
  expect(row).toBeNull();
  sqlite.close();
});

test("beforeRegister throwing generic Error returns 500 AUTH_HOOK_ERROR", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      beforeRegister: () => {
        throw new Error("Unexpected failure");
      },
    }),
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "carol@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("AUTH_HOOK_ERROR");
  sqlite.close();
});

test("beforeRegister cannot escalate privileges by overriding id or passwordHash", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      // Hook tries to force a specific id and bypass password hashing
      beforeRegister: ({ data }) => ({
        ...data,
        id: "injected-id",
        role: "admin",
        passwordHash: "plain-text-bypass",
      }),
    }),
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "hacker@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(201);

  // id must be the server-generated UUID, not the hook-injected value
  const row = sqlite
    .query("SELECT id, role, password_hash FROM users WHERE email = 'hacker@example.com'")
    .get() as any;
  expect(row?.id).not.toBe("injected-id");
  // passwordHash must be the bcrypt hash, not the hook-injected plain text
  expect(row?.password_hash).not.toBe("plain-text-bypass");
  // role CAN be modified by the hook since it's not a security-critical invariant
  // (role is part of the legitimate data surface)
  sqlite.close();
});

// ── afterRegister ─────────────────────────────────────────────────────────────

test("afterRegister receives created user", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  let capturedUserId: string | null = null;
  let capturedEmail: string | null = null;

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      afterRegister: ({ user, userId }) => {
        capturedUserId = userId;
        capturedEmail = user.email as string;
      },
    }),
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "dave@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(201);
  expect(capturedUserId).toBeString();
  expect(capturedEmail).toBe("dave@example.com");
  sqlite.close();
});

test("afterRegister error does not affect 201 response", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      afterRegister: () => {
        throw new Error("Side effect failed");
      },
    }),
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "eve@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(201);
  sqlite.close();
});

// ── beforeLogin ───────────────────────────────────────────────────────────────

test("beforeLogin throwing ApiError blocks login", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  // Seed a user with a separate IP so it doesn't eat rate limit for the login call
  const setupRoutes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });
  await setupRoutes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "locked@example.com", password: "password123" }),
    }),
  );

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      beforeLogin: ({ email }) => {
        if (email === "locked@example.com") {
          throw new ApiError("FORBIDDEN", "Account is locked", 403);
        }
      },
    }),
  });

  const res = await routes["/auth/login"].POST(
    makeReq("http://localhost/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "locked@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("FORBIDDEN");
  expect(body.error.message).toBe("Account is locked");
  sqlite.close();
});

test("beforeLogin generic Error returns 500 AUTH_HOOK_ERROR", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      beforeLogin: () => {
        throw new Error("Unexpected");
      },
    }),
  });

  const res = await routes["/auth/login"].POST(
    makeReq("http://localhost/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "anyone@example.com", password: "pass" }),
    }),
  );

  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("AUTH_HOOK_ERROR");
  sqlite.close();
});

// ── afterLogin ────────────────────────────────────────────────────────────────

test("afterLogin receives user after successful login", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const ip1 = freshIp();
  const ip2 = freshIp();

  const setupRoutes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });
  await setupRoutes["/auth/register"].POST(
    makeReq(
      "http://localhost/auth/register",
      {
        method: "POST",
        body: JSON.stringify({ email: "frank@example.com", password: "password123" }),
      },
      ip1,
    ),
  );

  let capturedUserId: string | null = null;

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      afterLogin: ({ userId }) => {
        capturedUserId = userId;
      },
    }),
  });

  const res = await routes["/auth/login"].POST(
    makeReq(
      "http://localhost/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email: "frank@example.com", password: "password123" }),
      },
      ip2,
    ),
  );

  expect(res.status).toBe(200);
  expect(capturedUserId).toBeString();
  sqlite.close();
});

test("afterLogin error does not affect 200 response", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const ip1 = freshIp();
  const ip2 = freshIp();

  const setupRoutes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });
  await setupRoutes["/auth/register"].POST(
    makeReq(
      "http://localhost/auth/register",
      {
        method: "POST",
        body: JSON.stringify({ email: "grace@example.com", password: "password123" }),
      },
      ip1,
    ),
  );

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    authHooks: defineAuthHooks({
      afterLogin: () => {
        throw new Error("Log failed");
      },
    }),
  });

  const res = await routes["/auth/login"].POST(
    makeReq(
      "http://localhost/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email: "grace@example.com", password: "password123" }),
      },
      ip2,
    ),
  );

  expect(res.status).toBe(200);
  sqlite.close();
});

// ── no auth hooks ─────────────────────────────────────────────────────────────

test("no auth hooks defined — auth works normally", async () => {
  const { sqlite, db, internalSchema } = setupDb();

  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    // no authHooks
  });

  const res = await routes["/auth/register"].POST(
    makeReq("http://localhost/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "ivan@example.com", password: "password123" }),
    }),
  );

  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.user.email).toBe("ivan@example.com");
  sqlite.close();
});

// ── afterEmailVerify ──────────────────────────────────────────────────────────

test("afterEmailVerify fires after verification succeeds", async () => {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      email_verified INTEGER DEFAULT 0
    )
  `);

  sqlite.run(
    `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'judy@example.com', 'hash', 'user')`,
  );

  const rawToken = "verify-token-abc123";
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(rawToken));
  const tokenHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sqlite.run(
    `INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at) VALUES ('tok1', 'u1', '${tokenHash}', 'email_verification', ${expiresAt}, '2024-01-01')`,
  );

  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");

  const usersTableWithVerified = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("user"),
    emailVerified: text("email_verified"),
  });

  let capturedUserId: string | null = null;

  const emailRoutes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable: usersTableWithVerified,
    authHooks: defineAuthHooks({
      afterEmailVerify: ({ userId }) => {
        capturedUserId = userId;
      },
    }),
  });

  const res = await emailRoutes["/auth/verify-email"].POST(
    new Request("http://localhost/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: rawToken }),
    }),
  );

  expect(res.status).toBe(200);
  expect(capturedUserId).toBe("u1");
  sqlite.close();
});

// ── beforePasswordReset ───────────────────────────────────────────────────────

test("beforePasswordReset can abort with ApiError", async () => {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    )
  `);
  sqlite.run(
    `INSERT INTO users (id, email, password_hash, role) VALUES ('u2', 'kim@example.com', 'hash', 'user')`,
  );

  const rawToken = "reset-token-xyz";
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(rawToken));
  const tokenHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sqlite.run(
    `INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at) VALUES ('tok2', 'u2', '${tokenHash}', 'password_reset', ${expiresAt}, '2024-01-01')`,
  );

  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");

  const usersTableSimple = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("user"),
  });

  const emailRoutes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable: usersTableSimple,
    authHooks: defineAuthHooks({
      beforePasswordReset: () => {
        throw new ApiError("FORBIDDEN", "Password resets are disabled", 403);
      },
    }),
  });

  const ip = freshIp();
  const res = await emailRoutes["/auth/reset-password"].POST(
    makeReq(
      "http://localhost/auth/reset-password",
      {
        method: "POST",
        body: JSON.stringify({ token: rawToken, password: "newpassword123" }),
      },
      ip,
    ),
  );

  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("FORBIDDEN");

  // Password should NOT have been changed
  const row = sqlite.query("SELECT password_hash FROM users WHERE id = 'u2'").get() as any;
  expect(row?.password_hash).toBe("hash");
  sqlite.close();
});

test("beforePasswordReset generic Error returns 500 AUTH_HOOK_ERROR", async () => {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    )
  `);
  sqlite.run(
    `INSERT INTO users (id, email, password_hash, role) VALUES ('u2b', 'mia@example.com', 'hash', 'user')`,
  );

  const rawToken = "reset-token-mia";
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(rawToken));
  const tokenHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sqlite.run(
    `INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at) VALUES ('tok2b', 'u2b', '${tokenHash}', 'password_reset', ${expiresAt}, '2024-01-01')`,
  );

  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");

  const usersTableSimple = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("user"),
  });

  const emailRoutes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable: usersTableSimple,
    authHooks: defineAuthHooks({
      beforePasswordReset: () => {
        throw new Error("Unexpected failure");
      },
    }),
  });

  const ip = freshIp();
  const res = await emailRoutes["/auth/reset-password"].POST(
    makeReq(
      "http://localhost/auth/reset-password",
      {
        method: "POST",
        body: JSON.stringify({ token: rawToken, password: "newpassword123" }),
      },
      ip,
    ),
  );

  expect(res.status).toBe(500);
  const body = (await res.json()) as any;
  expect(body.error.code).toBe("AUTH_HOOK_ERROR");

  // Password should NOT have been changed
  const row = sqlite.query("SELECT password_hash FROM users WHERE id = 'u2b'").get() as any;
  expect(row?.password_hash).toBe("hash");
  sqlite.close();
});

// ── afterPasswordReset ────────────────────────────────────────────────────────

test("afterPasswordReset fires after successful reset", async () => {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    )
  `);
  sqlite.run(
    `INSERT INTO users (id, email, password_hash, role) VALUES ('u3', 'leo@example.com', 'old-hash', 'user')`,
  );

  const rawToken = "reset-token-leo";
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(rawToken));
  const tokenHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sqlite.run(
    `INSERT INTO _verification_tokens (id, user_id, token_hash, type, expires_at, created_at) VALUES ('tok3', 'u3', '${tokenHash}', 'password_reset', ${expiresAt}, '2024-01-01')`,
  );

  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");

  const usersTableSimple = sqliteTable("users", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("user"),
  });

  let capturedUserId: string | null = null;

  const emailRoutes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable: usersTableSimple,
    authHooks: defineAuthHooks({
      afterPasswordReset: ({ userId }) => {
        capturedUserId = userId;
      },
    }),
  });

  const ip = freshIp();
  const res = await emailRoutes["/auth/reset-password"].POST(
    makeReq(
      "http://localhost/auth/reset-password",
      {
        method: "POST",
        body: JSON.stringify({ token: rawToken, password: "newpassword123" }),
      },
      ip,
    ),
  );

  expect(res.status).toBe(200);
  expect(capturedUserId).toBe("u3");
  sqlite.close();
});
