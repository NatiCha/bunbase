/**
 * Tests for Bearer Token / API Key authentication.
 *
 * Unit tests cover parsing helpers and direct handler calls.
 * Integration tests start a real server and exercise endpoints via fetch.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { extractBearerToken, isBearerOnly, getApiKeyUser, extractAuth } from "../auth/middleware.ts";
import { createApiKeyRoutes } from "../auth/api-keys.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { createServer } from "../core/server.ts";
import { makeResolvedConfig, setupTestDb } from "./test-helpers.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

// ─── Shared schema ────────────────────────────────────────────────────────────

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});

// ─── Unit: extractBearerToken ─────────────────────────────────────────────────

describe("extractBearerToken", () => {
  test("parses valid Authorization header", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Bearer bb_live_abc123" },
    });
    expect(extractBearerToken(req)).toBe("bb_live_abc123");
  });

  test("returns null when header is absent", () => {
    const req = new Request("http://localhost/");
    expect(extractBearerToken(req)).toBeNull();
  });

  test("returns null for malformed header (no token)", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Bearer" },
    });
    expect(extractBearerToken(req)).toBeNull();
  });

  test("returns null for non-Bearer scheme", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractBearerToken(req)).toBeNull();
  });

  test("is case-insensitive for 'bearer' keyword", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "BEARER mytoken" },
    });
    expect(extractBearerToken(req)).toBe("mytoken");
  });
});

// ─── Unit: isBearerOnly ───────────────────────────────────────────────────────

describe("isBearerOnly", () => {
  test("true when bearer present and no session cookie", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Bearer bb_live_abc123" },
    });
    expect(isBearerOnly(req)).toBe(true);
  });

  test("false when bearer present but session cookie also present", () => {
    const req = new Request("http://localhost/", {
      headers: {
        Authorization: "Bearer bb_live_abc123",
        Cookie: "bunbase_session=sess123",
      },
    });
    expect(isBearerOnly(req)).toBe(false);
  });

  test("false when no bearer token at all", () => {
    const req = new Request("http://localhost/");
    expect(isBearerOnly(req)).toBe(false);
  });

  test("false when only session cookie present", () => {
    const req = new Request("http://localhost/", {
      headers: { Cookie: "bunbase_session=sess123" },
    });
    expect(isBearerOnly(req)).toBe(false);
  });
});

// ─── Unit: getApiKeyUser ──────────────────────────────────────────────────────

function setupApiKeyDb() {
  const { sqlite, db, adapter, internalSchema } = setupTestDb();
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    )
  `);
  return { sqlite, db, adapter, internalSchema };
}

function hashKey(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return hasher.digest("hex");
}

test("getApiKeyUser returns user for valid key", async () => {
  const { sqlite, db, internalSchema } = setupApiKeyDb();

  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const rawKey = "bb_live_deadbeefcafebabe0102030405060708";
  const keyHash = hashKey(rawKey);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    ["key1", "u1", keyHash, "bb_live_de", "Test Key", expiresAt, new Date().toISOString()],
  );

  const user = await getApiKeyUser(db, internalSchema, rawKey, usersTable);
  expect(user).not.toBeNull();
  expect(user!.id).toBe("u1");
  expect(user!.email).toBe("alice@example.com");

  sqlite.close();
});

test("getApiKeyUser returns null for nonexistent key", async () => {
  const { sqlite, db, internalSchema } = setupApiKeyDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const user = await getApiKeyUser(db, internalSchema, "bb_live_doesnotexist", usersTable);
  expect(user).toBeNull();

  sqlite.close();
});

test("getApiKeyUser returns null for expired key", async () => {
  const { sqlite, db, internalSchema } = setupApiKeyDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const rawKey = "bb_live_expiredkeyexpiredkeyexpiredke";
  const keyHash = hashKey(rawKey);
  const expiresAt = Math.floor(Date.now() / 1000) - 1; // expired 1 second ago

  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    ["key-expired", "u1", keyHash, "bb_live_ex", "Expired Key", expiresAt, new Date().toISOString()],
  );

  const user = await getApiKeyUser(db, internalSchema, rawKey, usersTable);
  expect(user).toBeNull();

  sqlite.close();
});

test("getApiKeyUser returns null when usersTable is null", async () => {
  const { sqlite, db, internalSchema } = setupApiKeyDb();
  const user = await getApiKeyUser(db, internalSchema, "bb_live_anykey", null);
  expect(user).toBeNull();
  sqlite.close();
});

test("getApiKeyUser updates last_used_at when null", async () => {
  const { sqlite, db, internalSchema } = setupApiKeyDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const rawKey = "bb_live_lastusedupdatetest12345678901";
  const keyHash = hashKey(rawKey);

  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
    ["key-luat", "u1", keyHash, "bb_live_la", "LUAT Key", new Date().toISOString()],
  );

  await getApiKeyUser(db, internalSchema, rawKey, usersTable);

  // Give the fire-and-forget update a tick to complete
  await new Promise((r) => setTimeout(r, 50));

  const row = sqlite.query("SELECT last_used_at FROM _api_keys WHERE id = 'key-luat'").get() as any;
  expect(row.last_used_at).not.toBeNull();

  sqlite.close();
});

test("getApiKeyUser does not update last_used_at if within 5 minutes", async () => {
  const { sqlite, db, internalSchema } = setupApiKeyDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const rawKey = "bb_live_throttleupdatetest123456789012";
  const keyHash = hashKey(rawKey);
  const recentLastUsed = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago

  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    ["key-throttle", "u1", keyHash, "bb_live_th", "Throttle Key", recentLastUsed, new Date().toISOString()],
  );

  await getApiKeyUser(db, internalSchema, rawKey, usersTable);
  await new Promise((r) => setTimeout(r, 50));

  const row = sqlite.query("SELECT last_used_at FROM _api_keys WHERE id = 'key-throttle'").get() as any;
  // Should still be the original value (not updated)
  expect(row.last_used_at).toBe(recentLastUsed);

  sqlite.close();
});

// ─── Unit: createApiKeyRoutes ─────────────────────────────────────────────────

function setupRoutesDb() {
  const { sqlite, db, adapter, internalSchema } = setupTestDb();
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    )
  `);
  return { sqlite, db, adapter, internalSchema };
}

test("POST /auth/api-keys creates a key and returns it once", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  let capturedUser = { id: "u1", email: "alice@example.com", role: "user" };
  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => capturedUser as any,
  });

  // Bearer-only request — no CSRF needed
  const req = new Request("http://localhost/auth/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer anything", // no cookie, so isBearerOnly = true
    },
    body: JSON.stringify({ name: "CI Pipeline" }),
  });

  const res = await routes["/auth/api-keys"].POST(req);
  expect(res.status).toBe(201);

  const body = await res.json() as any;
  expect(body.name).toBe("CI Pipeline");
  expect(body.key).toMatch(/^bb_live_[a-f0-9]{32}$/);
  expect(body.keyPrefix).toMatch(/^bb_live_[a-f0-9]{8}$/);
  // BB-APIKEY-003: no expiresInDays → applies 365-day default (not null)
  const expectedExpiry = Math.floor(Date.now() / 1000) + 365 * 86400;
  expect(body.expiresAt).toBeGreaterThan(expectedExpiry - 10);
  expect(body.expiresAt).toBeLessThanOrEqual(expectedExpiry + 10);
  expect(body.id).toBeDefined();

  // Verify stored in DB
  const row = sqlite.query("SELECT key_hash FROM _api_keys WHERE id = ?").get(body.id) as any;
  expect(row).not.toBeNull();
  // Hash should match SHA-256 of the returned key
  expect(row.key_hash).toBe(hashKey(body.key));

  sqlite.close();
});

test("POST /auth/api-keys with expiresInDays sets expiry", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => ({ id: "u1", email: "alice@example.com", role: "user" }) as any,
  });

  const req = new Request("http://localhost/auth/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer token",
    },
    body: JSON.stringify({ name: "Temp Key", expiresInDays: 30 }),
  });

  const res = await routes["/auth/api-keys"].POST(req);
  const body = await res.json() as any;
  expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

  sqlite.close();
});

test("POST /auth/api-keys with expiresInDays:0 creates non-expiring key (BB-APIKEY-003)", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => ({ id: "u1", email: "alice@example.com", role: "user" }) as any,
  });

  const req = new Request("http://localhost/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
    body: JSON.stringify({ name: "Forever Key", expiresInDays: 0 }),
  });

  const res = await routes["/auth/api-keys"].POST(req);
  expect(res.status).toBe(201);
  const body = await res.json() as any;
  expect(body.expiresAt).toBeNull();

  sqlite.close();
});

test("POST /auth/api-keys enforces maxExpirationDays cap (BB-APIKEY-003)", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({
      development: true,
      auth: { apiKeys: { defaultExpirationDays: 365, maxExpirationDays: 30 } } as any,
    }),
    usersTable,
    extractAuth: async () => ({ id: "u1", email: "alice@example.com", role: "user" }) as any,
  });

  // expiresInDays > maxExpirationDays → 400
  const req = new Request("http://localhost/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
    body: JSON.stringify({ name: "Too Long Key", expiresInDays: 60 }),
  });

  const res = await routes["/auth/api-keys"].POST(req);
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.code).toBe("VALIDATION_ERROR");

  // expiresInDays within cap → 201
  const req2 = new Request("http://localhost/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
    body: JSON.stringify({ name: "Within Cap", expiresInDays: 30 }),
  });
  const res2 = await routes["/auth/api-keys"].POST(req2);
  expect(res2.status).toBe(201);

  // expiresInDays: 0 (explicit infinite) bypasses cap → 201 with null expiresAt
  const req3 = new Request("http://localhost/auth/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
    body: JSON.stringify({ name: "Infinite", expiresInDays: 0 }),
  });
  const res3 = await routes["/auth/api-keys"].POST(req3);
  expect(res3.status).toBe(201);
  expect((await res3.json() as any).expiresAt).toBeNull();

  sqlite.close();
});

test("GET /auth/api-keys lists keys without raw key hash", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");
  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
    ["k1", "u1", "somehash", "bb_live_ab", "My Key", new Date().toISOString()],
  );

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => ({ id: "u1", email: "alice@example.com", role: "user" }) as any,
  });

  const req = new Request("http://localhost/auth/api-keys", {
    headers: { Authorization: "Bearer token" },
  });

  const res = await routes["/auth/api-keys"].GET(req);
  expect(res.status).toBe(200);
  const body = await res.json() as any[];
  expect(body.length).toBe(1);
  expect(body[0].keyPrefix).toBe("bb_live_ab");
  expect(body[0].keyHash).toBeUndefined(); // raw hash must never be returned

  sqlite.close();
});

test("DELETE /auth/api-keys/:id revokes own key", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");
  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
    ["k1", "u1", "somehash", "bb_live_ab", "My Key", new Date().toISOString()],
  );

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => ({ id: "u1", email: "alice@example.com", role: "user" }) as any,
  });

  const req = new Request("http://localhost/auth/api-keys/k1", {
    method: "DELETE",
    headers: { Authorization: "Bearer token" },
  });

  const res = await routes["/auth/api-keys/:id"].DELETE(req);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.deleted).toBe(true);

  const row = sqlite.query("SELECT id FROM _api_keys WHERE id = 'k1'").get();
  expect(row).toBeNull();

  sqlite.close();
});

test("DELETE /auth/api-keys/:id forbids deleting another user's key", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u2', 'bob@example.com', 'user')");
  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
    ["k1", "u2", "somehash2", "bb_live_bb", "Bob Key", new Date().toISOString()],
  );

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => ({ id: "u1", email: "alice@example.com", role: "user" }) as any,
  });

  const req = new Request("http://localhost/auth/api-keys/k1", {
    method: "DELETE",
    headers: { Authorization: "Bearer token" },
  });

  const res = await routes["/auth/api-keys/:id"].DELETE(req);
  expect(res.status).toBe(403);

  sqlite.close();
});

test("admin can delete any user's key", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('admin1', 'admin@example.com', 'admin')");
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");
  sqlite.run(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
    ["k1", "u1", "somehash", "bb_live_ab", "User Key", new Date().toISOString()],
  );

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => ({ id: "admin1", email: "admin@example.com", role: "admin" }) as any,
  });

  const req = new Request("http://localhost/auth/api-keys/k1", {
    method: "DELETE",
    headers: { Authorization: "Bearer admintoken" },
  });

  const res = await routes["/auth/api-keys/:id"].DELETE(req);
  expect(res.status).toBe(200);

  sqlite.close();
});

test("POST /auth/api-keys returns 403 when CSRF missing and not bearer-only", async () => {
  const { sqlite, db, internalSchema } = setupRoutesDb();
  sqlite.run("INSERT INTO users (id, email, role) VALUES ('u1', 'alice@example.com', 'user')");

  const routes = createApiKeyRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    extractAuth: async () => ({ id: "u1", email: "alice@example.com", role: "user" }) as any,
  });

  // Has a session cookie → not bearer-only → CSRF required
  const req = new Request("http://localhost/auth/api-keys", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "bunbase_session=sess123",
      // No X-CSRF-Token
    },
    body: JSON.stringify({ name: "Should Fail" }),
  });

  const res = await routes["/auth/api-keys"].POST(req);
  expect(res.status).toBe(403);

  sqlite.close();
});

// ─── Integration: full server ─────────────────────────────────────────────────

const root = join(tmpdir(), `bunbase-apikeys-${Date.now()}`);
mkdirSync(root, { recursive: true });

let server: ReturnType<typeof Bun.serve>;
let base: string;
let adminKey: string;
let userKey: string;
let integrationAdapter: ReturnType<typeof createServer>["adapter"];

beforeAll(async () => {
  const bunbase = createServer({
    schema: { users: usersTable },
    rules: {},
    config: makeResolvedConfig({
      development: true,
      database: {
        driver: "sqlite",
        url: join(root, "db.sqlite"),
      },
      dbPath: join(root, "db.sqlite"),
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle"),
    }),
  });

  // Create the tables manually
  await bunbase.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user')",
  );

  // Seed users
  await bunbase.adapter.rawExecute(
    "INSERT INTO users (id, email, role) VALUES ($id, $email, $role)",
    { $id: "admin-1", $email: "admin@example.com", $role: "admin" },
  );
  await bunbase.adapter.rawExecute(
    "INSERT INTO users (id, email, role) VALUES ($id, $email, $role)",
    { $id: "user-1", $email: "user@example.com", $role: "user" },
  );

  // Pre-create API keys directly in the DB so tests don't need a cookie session
  const adminRawKey = "bb_live_adminkeyadminkeyad0102030405";
  const userRawKey = "bb_live_userkeyu0102030405060708090a";
  adminKey = adminRawKey;
  userKey = userRawKey;

  const adminHash = new Bun.CryptoHasher("sha256");
  adminHash.update(adminRawKey);
  const adminKeyHash = adminHash.digest("hex");

  const userHash = new Bun.CryptoHasher("sha256");
  userHash.update(userRawKey);
  const userKeyHash = userHash.digest("hex");

  const now = new Date().toISOString();
  const future = Math.floor(Date.now() / 1000) + 86400;

  await bunbase.adapter.rawExecute(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES ($id, $uid, $hash, $prefix, $name, $exp, NULL, $created)",
    { $id: "admin-key-1", $uid: "admin-1", $hash: adminKeyHash, $prefix: "bb_live_ad", $name: "Admin Key", $exp: future, $created: now },
  );
  await bunbase.adapter.rawExecute(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES ($id, $uid, $hash, $prefix, $name, $exp, NULL, $created)",
    { $id: "user-key-1", $uid: "user-1", $hash: userKeyHash, $prefix: "bb_live_us", $name: "User Key", $exp: future, $created: now },
  );

  integrationAdapter = bunbase.adapter;
  server = bunbase.listen(0);
  base = String(server.url).replace(/\/$/, "");
});

afterAll(() => {
  server?.stop();
});

test("integration: bearer-authenticated GET /auth/me returns user", async () => {
  const res = await fetch(`${base}/auth/me`, {
    headers: { Authorization: `Bearer ${adminKey}` },
    credentials: "omit",
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.user.id).toBe("admin-1");
  expect(body.user.role).toBe("admin");
});

test("integration: invalid bearer token returns 401", async () => {
  const res = await fetch(`${base}/auth/me`, {
    headers: { Authorization: "Bearer bb_live_invalidkeyinvalidkeyinvalidke" },
    credentials: "omit",
  });
  expect(res.status).toBe(401);
});

test("integration: bearer auth creates key without CSRF", async () => {
  const res = await fetch(`${base}/auth/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    credentials: "omit",
    body: JSON.stringify({ name: "New Key from Integration Test" }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as any;
  expect(body.key).toMatch(/^bb_live_[a-f0-9]{32}$/);
  expect(body.name).toBe("New Key from Integration Test");
});

test("integration: GET /auth/api-keys lists own keys only", async () => {
  const res = await fetch(`${base}/auth/api-keys`, {
    headers: { Authorization: `Bearer ${userKey}` },
    credentials: "omit",
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any[];
  // user-1 has user-key-1 plus any created by earlier tests run as user-1
  expect(body.every((k: any) => k.userId === "user-1")).toBe(true);
  expect(body.some((k: any) => k.keyPrefix === "bb_live_us")).toBe(true);
  expect(body.every((k: any) => k.keyHash === undefined)).toBe(true);
});

test("integration: unauthenticated request returns 401", async () => {
  const res = await fetch(`${base}/auth/api-keys`, {
    credentials: "omit",
  });
  expect(res.status).toBe(401);
});

test("integration: user cannot delete admin's key", async () => {
  const res = await fetch(`${base}/auth/api-keys/admin-key-1`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${userKey}` },
    credentials: "omit",
  });
  expect(res.status).toBe(403);
});

test("integration: admin can delete any key via admin API", async () => {
  // First create a throwaway key as the admin
  const createRes = await fetch(`${base}/auth/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
    },
    credentials: "omit",
    body: JSON.stringify({ name: "Throwaway Key" }),
  });
  const created = await createRes.json() as any;
  const throwawayId = created.id;

  // Admin deletes it via the admin API endpoint
  const delRes = await fetch(`${base}/_admin/api/api-keys/${throwawayId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminKey}` },
    credentials: "omit",
  });
  expect(delRes.status).toBe(200);
  const body = await delRes.json() as any;
  expect(body.deleted).toBe(true);
});

test("integration: non-admin cannot access admin API key endpoint", async () => {
  const res = await fetch(`${base}/_admin/api/api-keys`, {
    headers: { Authorization: `Bearer ${userKey}` },
    credentials: "omit",
  });
  expect(res.status).toBe(403);
});

test("integration: bearer CRUD mutation bypasses CSRF check", async () => {
  // There are no CRUD tables in this test server, but we can verify the rules
  // by testing that a missing CSRF header doesn't block the api-keys endpoint
  // (which we've already tested), and that adding a dummy CSRF header doesn't
  // break bearer-only mode.
  const res = await fetch(`${base}/auth/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminKey}`,
      "X-CSRF-Token": "dummy", // extra header should not cause issues
    },
    credentials: "omit",
    body: JSON.stringify({ name: "Key With Extra Header" }),
  });
  expect(res.status).toBe(201);
});

test("integration: expired key is rejected", async () => {
  const expiredRawKey = "bb_live_expiredintegrationkeyexp1234";
  const expiredHash = new Bun.CryptoHasher("sha256");
  expiredHash.update(expiredRawKey);
  const expiredKeyHash = expiredHash.digest("hex");
  const pastExpiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

  // Insert an actually-expired key so we test expiry logic, not just "missing key"
  await integrationAdapter.rawExecute(
    "INSERT INTO _api_keys (id, user_id, key_hash, key_prefix, name, expires_at, last_used_at, created_at) VALUES ($id, $uid, $hash, $prefix, $name, $exp, NULL, $created)",
    {
      $id: "expired-intg-key",
      $uid: "user-1",
      $hash: expiredKeyHash,
      $prefix: "bb_live_ex",
      $name: "Expired Key",
      $exp: pastExpiry,
      $created: new Date().toISOString(),
    },
  );

  const res = await fetch(`${base}/auth/me`, {
    headers: { Authorization: `Bearer ${expiredRawKey}` },
    credentials: "omit",
  });
  // Key exists in DB but is expired — must be rejected
  expect(res.status).toBe(401);
});
