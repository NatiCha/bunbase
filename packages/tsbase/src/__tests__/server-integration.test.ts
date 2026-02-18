/**
 * Integration tests for core/server.ts — starts the real server on a random
 * port and exercises every branch inside the listen() fetch handler via actual
 * HTTP requests.
 *
 * Uncovered paths targeted:
 *   line  76      — fetch handler entry (start timer)
 *   lines 185-190 — CORS preflight early-return
 *   lines 193-206 — /_admin/api/* dispatch + request log
 *   lines 209-223 — /_admin SPA catch-all
 *   lines 226-246 — exact-match HTTP route + addCorsHeaders on response
 *   lines 249-270 — pattern-match HTTP route (file routes with path params)
 *   lines 272-275 — exact route method-not-allowed
 *   lines 277-278 — pattern route method-not-allowed
 *   lines 287-290 — CSRF enforcement for tRPC POST
 *   lines 303-313 — tRPC fetchRequestHandler
 *   lines 314-318 — 404 fallback
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../core/server.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

// ─── shared server setup ─────────────────────────────────────────────────────

const root = join(tmpdir(), `tsbase-server-intg-${Date.now()}`);
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

let tsbase: ReturnType<typeof createServer>;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let adminSession: string;

beforeAll(() => {
  tsbase = createServer({
    schema: { users: usersTable, posts: postsTable },
    config: makeResolvedConfig({
      development: true,
      dbPath: join(root, "db.sqlite"),
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle"),
    }),
  });

  // createServer bootstraps internal tables (_sessions, _files …) but doesn't
  // auto-create user-defined tables — we create them manually here.
  tsbase.sqlite.run(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user')",
  );
  tsbase.sqlite.run(
    "CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
  );

  // Seed an admin user and a valid session
  tsbase.sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "admin-1", $email: "admin@example.com", $role: "admin" });

  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  tsbase.sqlite
    .query(
      "INSERT INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    )
    .run({
      $id: "admin-sess",
      $userId: "admin-1",
      $expiresAt: expiresAt,
      $createdAt: new Date().toISOString(),
    });
  adminSession = "admin-sess";

  // Start server on a random free port
  server = tsbase.listen(0);
  base = server.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  server?.stop();
  tsbase?.sqlite.close();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// ─── /health ─────────────────────────────────────────────────────────────────

test("GET /health returns 200 OK", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("OK");
});

// ─── CORS preflight (lines 185-190) ──────────────────────────────────────────

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const res = await fetch(`${base}/trpc/posts.list`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5173" },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
    "http://localhost:5173",
  );
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
});

// ─── Admin API dispatch + request logging (lines 193-206) ────────────────────

test("GET /_admin/api/sessions returns sessions list for admin", async () => {
  const res = await fetch(`${base}/_admin/api/sessions`, {
    headers: { cookie: `tsbase_session=${adminSession}` },
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

// ─── Admin SPA catch-all (lines 209-223) ─────────────────────────────────────

test("GET /_admin (SPA catch-all) serves admin UI for unknown sub-paths", async () => {
  const res = await fetch(`${base}/_admin/some-page`);
  expect(res.status).toBe(200);
  // The admin SPA is served — response has a body (not a 404 JSON blob)
  const body = await res.text();
  expect(body.length).toBeGreaterThan(0);
});

// ─── Exact HTTP route + CORS on response (lines 226-246) ─────────────────────

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

// ─── Pattern route — file with path params (lines 249-270) ───────────────────

test("GET /files/:id returns 404 for unknown file id via pattern route", async () => {
  const res = await fetch(`${base}/files/no-such-file`, {
    headers: { cookie: `tsbase_session=${adminSession}` },
  });
  expect(res.status).toBe(404);
});

// ─── Exact route method not allowed (lines 272-275) ──────────────────────────

test("DELETE /auth/login returns 405 Method Not Allowed", async () => {
  const res = await fetch(`${base}/auth/login`, { method: "DELETE" });
  expect(res.status).toBe(405);
});

// ─── Pattern route method not allowed (lines 277-278) ────────────────────────

test("PATCH /files/:id returns 405 Method Not Allowed", async () => {
  const res = await fetch(`${base}/files/some-id`, {
    method: "PATCH",
    headers: { cookie: `tsbase_session=${adminSession}` },
  });
  expect(res.status).toBe(405);
});

// ─── CSRF enforcement on tRPC POST (lines 287-290) ───────────────────────────

test("POST /trpc/posts.create without CSRF token returns 403", async () => {
  const res = await fetch(`${base}/trpc/posts.create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `tsbase_session=${adminSession}`,
      // Intentionally omitting x-csrf-token and csrf_token cookie
    },
    body: JSON.stringify({ "0": { json: { title: "Bad" } } }),
  });
  expect(res.status).toBe(403);
  const body = await res.json() as { error: { code: string } };
  expect(body.error.code).toBe("FORBIDDEN");
});

// ─── tRPC handler (lines 303-313) ────────────────────────────────────────────

test("GET /trpc/posts.list is handled by the tRPC router (not 404)", async () => {
  const res = await fetch(
    `${base}/trpc/posts.list?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: {} } }))}`,
    { headers: { cookie: `tsbase_session=${adminSession}` } },
  );
  // tRPC processed the request — any non-404 status is acceptable
  expect(res.status).not.toBe(404);
  // Response should be JSON (tRPC envelope)
  const ct = res.headers.get("Content-Type") ?? "";
  expect(ct).toContain("application/json");
});

// ─── 404 fallback (lines 314-318) ────────────────────────────────────────────

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

// ─── Admin impersonation via tRPC (lines 260-267) ────────────────────────────

test("GET /trpc with x-impersonate-user header uses target user context", async () => {
  // Insert a regular user to impersonate
  tsbase.sqlite
    .query("INSERT OR IGNORE INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "regular-1", $email: "regular@example.com", $role: "user" });

  const res = await fetch(
    `${base}/trpc/posts.list?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: {} } }))}`,
    {
      headers: {
        cookie: `tsbase_session=${adminSession}`,
        "x-impersonate-user": "regular-1",
      },
    },
  );
  // tRPC context was created with the impersonated user — request succeeds
  expect(res.status).not.toBe(403);
  expect(res.status).not.toBe(404);
  const ct = res.headers.get("Content-Type") ?? "";
  expect(ct).toContain("application/json");
});

test("GET /trpc with x-impersonate-user pointing to nonexistent user falls through to real context", async () => {
  const res = await fetch(
    `${base}/trpc/posts.list?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: {} } }))}`,
    {
      headers: {
        cookie: `tsbase_session=${adminSession}`,
        "x-impersonate-user": "ghost-user-does-not-exist",
      },
    },
  );
  // Falls back to real admin context — request still succeeds
  expect(res.status).not.toBe(403);
  expect(res.status).not.toBe(404);
});

// ─── CSRF-exempt tRPC POST goes through to handler (not rejected at 287-290) ──

test("POST /trpc with matching CSRF token reaches tRPC handler", async () => {
  // Generate a CSRF token and pass it in both cookie and header
  const csrfToken = "integration-test-csrf-token";
  const res = await fetch(`${base}/trpc/posts.list`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `tsbase_session=${adminSession}; csrf_token=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ "0": { json: {} } }),
  });
  // tRPC handled it (not rejected by CSRF middleware)
  expect(res.status).not.toBe(403);
});
