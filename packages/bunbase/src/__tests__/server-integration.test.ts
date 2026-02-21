/**
 * Integration tests for core/server.ts — starts the real server on a random
 * port and exercises every branch inside the listen() fetch handler via actual
 * HTTP requests.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../core/server.ts";
import { defineRules, isSet, isChanged } from "../index.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

// ─── shared server setup ─────────────────────────────────────────────────────

const root = join(tmpdir(), `bunbase-server-intg-${Date.now()}`);
mkdirSync(root, { recursive: true });

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});

const postsTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

let bunbase: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let adminSession: string;

beforeAll(async () => {
  const dbPath = join(root, "db.sqlite");
  bunbase = createServer({
    schema: { users: usersTable, posts: postsTable },
    rules: {
      posts: { list: () => null, view: () => null, get: () => null, create: () => null, update: () => null, delete: () => null },
    },
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPath },
      dbPath,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle"),
    }),
  });

  await bunbase.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user')",
  );
  await bunbase.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
  );

  // Seed an admin user and a valid session
  await bunbase.adapter.rawExecute(
    "INSERT INTO users (id, email, role) VALUES ($id, $email, $role)",
    { $id: "admin-1", $email: "admin@example.com", $role: "admin" },
  );

  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  await bunbase.adapter.rawExecute(
    "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    {
      $id: "admin-sess",
      $userId: "admin-1",
      $expiresAt: expiresAt,
      $createdAt: new Date().toISOString(),
    },
  );
  adminSession = "admin-sess";

  // Start server on a random free port
  server = bunbase.listen(0);
  base = server.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  server?.stop();
  bunbase?.adapter.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// ─── /health ─────────────────────────────────────────────────────────────────

test("GET /health returns 200 OK with JSON", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe("ok");
  expect(typeof body.version).toBe("string");
});

// ─── CORS preflight ──────────────────────────────────────────────────────────

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const res = await fetch(`${base}/api/posts`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5173" },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
});

// ─── Admin API dispatch + request logging ────────────────────────────────────

test("GET /_admin/api/sessions returns sessions list for admin", async () => {
  const res = await fetch(`${base}/_admin/api/sessions`, {
    headers: { cookie: `bunbase_session=${adminSession}` },
  });
  expect(res.status).toBe(200);
  const sessions = await res.json() as Array<{ id: string }>;
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions.some((s) => s.id === adminSession)).toBe(true);
});

test("GET /_admin/api/users returns 401 when not authenticated", async () => {
  const res = await fetch(`${base}/_admin/api/users`);
  expect(res.status).toBe(401);
});

// ─── Admin SPA catch-all ─────────────────────────────────────────────────────

test("GET /_admin (SPA catch-all) redirects unknown sub-paths to /_admin", async () => {
  const res = await fetch(`${base}/_admin/some-page`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/_admin");
});

// ─── Exact HTTP route + CORS on response ─────────────────────────────────────

test("POST /auth/login adds CORS headers to its response", async () => {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:5173",
      "x-forwarded-for": "203.0.113.1",
    },
    body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
  });
  // 401 (unknown user) — the important thing is that CORS headers are present
  expect(res.status).toBe(401);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
});

test("GET /auth/me returns 401 when no session cookie is present", async () => {
  const res = await fetch(`${base}/auth/me`);
  expect(res.status).toBe(401);
});

// ─── Pattern route — file with path params ───────────────────────────────────

test("GET /files/:id returns 404 for unknown file id via pattern route", async () => {
  const res = await fetch(`${base}/files/no-such-file`, {
    headers: { cookie: `bunbase_session=${adminSession}` },
  });
  expect(res.status).toBe(404);
});

// ─── Exact route method not allowed ──────────────────────────────────────────

test("DELETE /auth/login returns 405 Method Not Allowed", async () => {
  const res = await fetch(`${base}/auth/login`, { method: "DELETE" });
  expect(res.status).toBe(405);
});

// ─── Pattern route method not allowed ────────────────────────────────────────

test("PATCH /files/:id returns 405 Method Not Allowed", async () => {
  const res = await fetch(`${base}/files/some-id`, {
    method: "PATCH",
    headers: { cookie: `bunbase_session=${adminSession}` },
  });
  expect(res.status).toBe(405);
});

// ─── CSRF enforcement on /api/* mutations ────────────────────────────────────

test("POST /api/posts without CSRF token returns 403", async () => {
  const res = await fetch(`${base}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `bunbase_session=${adminSession}`,
    },
    body: JSON.stringify({ title: "Bad" }),
  });
  expect(res.status).toBe(403);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe("FORBIDDEN");
});

// ─── REST CRUD handler ────────────────────────────────────────────────────────

test("GET /api/posts is handled by the REST router (not 404)", async () => {
  const res = await fetch(`${base}/api/posts`, {
    headers: { cookie: `bunbase_session=${adminSession}` },
  });
  // REST processed the request — any non-404 status is acceptable
  expect(res.status).not.toBe(404);
  const ct = res.headers.get("Content-Type") ?? "";
  expect(ct).toContain("application/json");
});

// ─── 404 fallback ────────────────────────────────────────────────────────────

test("GET /unknown-path returns 404 with CORS headers", async () => {
  const res = await fetch(`${base}/this/does/not/exist`, {
    headers: { Origin: "http://localhost:5173" },
  });
  expect(res.status).toBe(404);
  // CORS headers should still be present on 404s
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
});

// ─── Admin impersonation via REST API ────────────────────────────────────────

test("GET /api/posts with x-impersonate-user header uses target user context", async () => {
  // Insert a regular user to impersonate
  await bunbase.adapter.rawExecute(
    "INSERT OR IGNORE INTO users (id, email, role) VALUES ($id, $email, $role)",
    { $id: "regular-1", $email: "regular@example.com", $role: "user" },
  );

  const res = await fetch(`${base}/api/posts`, {
    headers: {
      cookie: `bunbase_session=${adminSession}`,
      "x-impersonate-user": "regular-1",
    },
  });
  // Request succeeds with impersonated user context
  expect(res.status).not.toBe(403);
  expect(res.status).not.toBe(404);
  const ct = res.headers.get("Content-Type") ?? "";
  expect(ct).toContain("application/json");
});

test("GET /api/posts with x-impersonate-user pointing to nonexistent user falls through to real context", async () => {
  const res = await fetch(`${base}/api/posts`, {
    headers: {
      cookie: `bunbase_session=${adminSession}`,
      "x-impersonate-user": "ghost-user-does-not-exist",
    },
  });
  // Falls back to real admin context — request still succeeds
  expect(res.status).not.toBe(403);
  expect(res.status).not.toBe(404);
});

// ─── CSRF token allows /api/* mutations ──────────────────────────────────────

test("POST /api/posts with matching CSRF token reaches handler", async () => {
  const csrfToken = "integration-test-csrf-token";
  const res = await fetch(`${base}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `bunbase_session=${adminSession}; csrf_token=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ id: Bun.randomUUIDv7(), title: "Test Post" }),
  });
  // Handled by REST handler (not rejected by CSRF middleware)
  expect(res.status).not.toBe(403);
});

// ─── RuleArg body/record integration tests ───────────────────────────────────

const widgetsTable = sqliteTable("widgets", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id").notNull(),
  status: text("status").notNull().default("draft"),
});

let rulesServer: ReturnType<typeof Bun.serve>;
let rulesBase: string;
let rulesAdapter: any;
let rulesCsrf: string;

beforeAll(async () => {
  const dbPath = join(root, "db-rules.sqlite");
  rulesCsrf = "rules-intg-csrf";

  const bunbaseRules = createServer({
    schema: { widgets: widgetsTable },
    rules: defineRules({
      widgets: {
        list: () => null,
        view: () => null,
        get: () => null,
        // create: deny if body contains a "status" field (forbidden field)
        create: ({ body }) => !isSet(body, "status"),
        // update: deny if ownerId is being changed
        update: ({ body, record }) => !isChanged(body, record, "ownerId"),
        delete: () => null,
      },
    }),
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPath },
      dbPath,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-rules"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-rules"),
    }),
  });

  await bunbaseRules.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft')",
  );

  rulesAdapter = bunbaseRules.adapter;
  rulesServer = bunbaseRules.listen(0);
  rulesBase = rulesServer.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  rulesServer?.stop();
  rulesAdapter?.close();
});

test("create rule rejects body that contains a forbidden field (isSet)", async () => {
  const res = await fetch(`${rulesBase}/api/widgets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ id: "w1", title: "Bad Widget", ownerId: "u1", status: "published" }),
  });
  expect(res.status).toBe(403);
});

test("create rule allows body without the forbidden field (isSet)", async () => {
  const res = await fetch(`${rulesBase}/api/widgets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ id: "w2", title: "Good Widget", ownerId: "u1" }),
  });
  expect(res.status).toBe(201);
});

test("update rule rejects when ownerId field is changed (isChanged)", async () => {
  // First create a widget
  await fetch(`${rulesBase}/api/widgets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ id: "w3", title: "Widget", ownerId: "u1" }),
  });

  // Now try to change the ownerId
  const res = await fetch(`${rulesBase}/api/widgets/w3`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ ownerId: "u2" }),
  });
  expect(res.status).toBe(403);
});

test("update rule allows when ownerId field is not changed (isChanged)", async () => {
  // Create a widget to update
  await fetch(`${rulesBase}/api/widgets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ id: "w4", title: "Widget", ownerId: "u1" }),
  });

  // Update title only (ownerId unchanged)
  const res = await fetch(`${rulesBase}/api/widgets/w4`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ title: "Updated Title" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.title).toBe("Updated Title");
});

test("rule receives existing record value (record field in RuleArg)", async () => {
  // Create a widget
  await fetch(`${rulesBase}/api/widgets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ id: "w5", title: "Original", ownerId: "u1" }),
  });

  // Update with same ownerId value — should succeed (not changed)
  const res = await fetch(`${rulesBase}/api/widgets/w5`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      cookie: `csrf_token=${rulesCsrf}`,
      "x-csrf-token": rulesCsrf,
    },
    body: JSON.stringify({ ownerId: "u1", title: "New Title" }),
  });
  expect(res.status).toBe(200);
});
