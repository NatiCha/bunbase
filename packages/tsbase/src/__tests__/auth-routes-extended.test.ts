import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createAuthRoutes } from "../auth/routes.ts";
import { bootstrapInternalTables } from "../core/bootstrap.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});

function setupDb(): Database {
  const sqlite = new Database(":memory:");
  bootstrapInternalTables(sqlite);
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    )
  `);
  return sqlite;
}

// Each test uses a unique x-forwarded-for IP so the shared rate-limit store
// does not leak between files running in the same Bun worker.
let _ipSuffix = 200;
function uniqueIp(): string {
  return `172.30.0.${_ipSuffix++}`;
}

function makeReq(path: string, options: RequestInit, ip?: string): Request {
  const headers = new Headers(options.headers);
  headers.set("x-forwarded-for", ip ?? uniqueIp());
  return new Request(`http://localhost${path}`, { ...options, headers });
}

// /auth/register — error branches

test("register returns 400 for invalid JSON body", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("register returns 400 when password is too short", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "short" }),
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("register returns 409 when email is already registered", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });
  const ip = uniqueIp(); // same IP for both requests in this test

  await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dupe@example.com", password: "password123" }),
    }, ip),
  );

  const response = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dupe@example.com", password: "password123" }),
    }, ip),
  );
  expect(response.status).toBe(409);
  sqlite.close();
});

test("register returns 500 when usersTable is null", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable: null,
  });

  const response = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "password123" }),
    }),
  );
  expect(response.status).toBe(500);
  sqlite.close();
});

// /auth/login — error branches

test("login returns 400 for invalid JSON", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/login"].POST(
    makeReq("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("login returns 400 for missing fields", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/login"].POST(
    makeReq("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" }), // missing password
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("login returns 401 for unknown email", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/login"].POST(
    makeReq("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "password123" }),
    }),
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

test("login returns 401 for wrong password", async () => {
  const sqlite = setupDb();
  const passwordHash = await Bun.password.hash("correctpass");
  sqlite
    .query(
      "INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $hash, $role)",
    )
    .run({
      $id: "u1",
      $email: "wrong@example.com",
      $hash: passwordHash,
      $role: "user",
    });

  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/login"].POST(
    makeReq("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "wrong@example.com", password: "wrongpass" }),
    }),
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

test("login returns 401 for OAuth user without password hash", async () => {
  const sqlite = setupDb();
  sqlite
    .query(
      "INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $hash, $role)",
    )
    .run({
      $id: "oauth-user",
      $email: "oauth@example.com",
      $hash: null,
      $role: "user",
    });

  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/login"].POST(
    makeReq("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "oauth@example.com", password: "password123" }),
    }),
  );
  expect(response.status).toBe(401);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("OAuth");
  sqlite.close();
});

// /auth/logout — CSRF protection

test("logout returns 403 when CSRF token is missing", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/logout"].POST(
    new Request("http://localhost/auth/logout", { method: "POST" }),
  );
  expect(response.status).toBe(403);
  sqlite.close();
});

// /auth/me

test("/auth/me returns 401 when no session cookie is present", async () => {
  const sqlite = setupDb();
  bootstrapInternalTables(sqlite);
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/me"].GET(
    new Request("http://localhost/auth/me"),
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

// register — non-record JSON body (array/number)

test("register returns 400 when JSON body is an array", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not", "an", "object"]),
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

// register — extra field whose Drizzle key is not blocked but whose DB column name IS (lines 185-193)
// e.g., key="myRole" → column name="role". The field name "myRole" passes the direct BLOCKED check
// (line 168) but the resolved column name "role" triggers the secondary check (lines 185-193).

const usersTableWithRoleAlias = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  myRole: text("role").notNull().default("user"), // key differs from blocked DB column name
});

test("register returns 400 when signup field maps via column name to a blocked field", async () => {
  const sqlite = setupDb(); // existing schema still has a "role" column — alias still maps to it
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable: usersTableWithRoleAlias,
  });

  const response = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // "myRole" is not in BLOCKED_SIGNUP_FIELDS directly, but maps to DB column "role" which is
      body: JSON.stringify({ email: "user@example.com", password: "password123", myRole: "admin" }),
    }),
  );
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("cannot be set during signup");
  sqlite.close();
});

// register — missing required schema fields

const usersWithRequiredCompany = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  company: text("company").notNull(), // required, no default, not blocked
});

function setupDbWithCompany(): Database {
  const sqlite = new Database(":memory:");
  bootstrapInternalTables(sqlite);
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      company TEXT NOT NULL
    )
  `);
  return sqlite;
}

test("register returns 400 when a required schema field is missing", async () => {
  const sqlite = setupDbWithCompany();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable: usersWithRequiredCompany,
  });

  const response = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // company is required but not provided
      body: JSON.stringify({ email: "user@example.com", password: "password123" }),
    }),
  );
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("company");
  sqlite.close();
});

// /auth/register — rate-limit block (auth/routes.ts lines 57-63)

test("register returns 429 after exceeding the rate limit", async () => {
  const sqlite = setupDb();
  const routes = createAuthRoutes({
    sqlite,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  // Use a dedicated IP that no other test in this file touches
  const blockedIp = "198.51.100.200";

  // Make 10 requests (exhausts the allowance; the 11th will be blocked)
  for (let i = 0; i < 10; i++) {
    await routes["/auth/register"].POST(
      makeReq("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Invalid JSON triggers a fast 400 with minimal overhead
        body: "bad",
      }, blockedIp),
    );
  }

  // The 11th request should be rate-limited (429)
  const blocked = await routes["/auth/register"].POST(
    makeReq("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "bad",
    }, blockedIp),
  );
  expect(blocked.status).toBe(429);
  sqlite.close();
});
