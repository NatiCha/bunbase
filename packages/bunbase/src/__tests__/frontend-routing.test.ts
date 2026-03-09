/**
 * Integration tests for frontend SPA serving (config.frontend.html).
 * Verifies that API, auth, and admin routes continue to be handled by masterFetch
 * when a SPA catch-all is registered, and that unknown paths fall through to the
 * SPA handler. Also guards against regressions on servers without frontend config.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createServer } from "../core/server.ts";

const root = join(tmpdir(), `bunbase-frontend-routing-${Date.now()}`);
mkdirSync(root, { recursive: true });

const tasksTable = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

const schema = { tasks: tasksTable };

const openRules = {
  list: () => null,
  get: () => null,
  create: () => null,
  update: () => null,
  delete: () => null,
};

// Mock SPA handler — a function so Bun can call it fresh per request
// (avoids the read-once issue with static Response objects).
const spaHandler = (_req: Request) =>
  new Response("SPA", { headers: { "Content-Type": "text/html" } });

// Server WITH frontend.html set
let srvWithFrontend: ReturnType<typeof Bun.serve>;
let baseWithFrontend: string;

// Server WITHOUT frontend.html (baseline — must still return 404 for unknown routes)
let srvNoFrontend: ReturnType<typeof Bun.serve>;
let baseNoFrontend: string;

beforeAll(async () => {
  const dbPathWith = join(root, "db-with.sqlite");
  const dbPathNo = join(root, "db-no.sqlite");

  const serverWith = createServer({
    schema,
    rules: { tasks: openRules },
    config: {
      development: true,
      database: { driver: "sqlite", url: dbPathWith },
      frontend: { html: spaHandler },
    },
  });

  await serverWith.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
  );
  await serverWith.adapter.rawExecute("INSERT INTO tasks (id, title) VALUES ('t1', 'Task 1')");

  srvWithFrontend = serverWith.listen(0);
  baseWithFrontend = `http://localhost:${srvWithFrontend.port}`;

  const serverNo = createServer({
    schema,
    rules: { tasks: openRules },
    config: {
      development: true,
      database: { driver: "sqlite", url: dbPathNo },
      // No frontend config
    },
  });

  await serverNo.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
  );

  srvNoFrontend = serverNo.listen(0);
  baseNoFrontend = `http://localhost:${srvNoFrontend.port}`;
});

afterAll(() => {
  srvWithFrontend?.stop(true);
  srvNoFrontend?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

// ─── API routes win over SPA catch-all ────────────────────────────────────

test("GET /api/tasks returns JSON even when frontend is enabled", async () => {
  const res = await fetch(`${baseWithFrontend}/api/tasks`);
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("application/json");
  const body = (await res.json()) as any;
  expect(body.data).toBeArray();
});

test("GET /api/tasks?limit=-1 returns JSON (not SPA) when frontend is enabled", async () => {
  const res = await fetch(`${baseWithFrontend}/api/tasks?limit=-1`);
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("application/json");
  const body = (await res.json()) as any;
  expect(body.nextCursor).toBeNull();
});

// ─── Auth routes win over SPA catch-all ───────────────────────────────────

test("GET /auth/me returns JSON (not SPA) when frontend is enabled", async () => {
  const res = await fetch(`${baseWithFrontend}/auth/me`);
  // 401 or 200 depending on session — either way it must be JSON, not the SPA
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("application/json");
});

// ─── Admin SPA catch-all serves HTML for deep links ──────────────────────

test("GET /_admin/some-path serves admin HTML (supports History API deep links)", async () => {
  const res = await fetch(`${baseWithFrontend}/_admin/some-arbitrary-path`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

test("GET /_admin/another serves admin HTML even with deep path", async () => {
  const res = await fetch(`${baseWithFrontend}/_admin/settings/users`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});

// ─── SPA catch-all served for unknown paths ───────────────────────────────

test("GET /some-unknown-route returns SPA (200 text/html) when frontend is enabled", async () => {
  const res = await fetch(`${baseWithFrontend}/some-unknown-route`);
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("text/html");
  const body = await res.text();
  expect(body).toBe("SPA");
});

test("GET /deeply/nested/spa/route returns SPA when frontend is enabled", async () => {
  const res = await fetch(`${baseWithFrontend}/deeply/nested/spa/route`);
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("text/html");
});

// ─── Without frontend: unknown paths still return 404 ────────────────────

test("GET /some-unknown-route returns 404 when frontend is NOT enabled", async () => {
  const res = await fetch(`${baseNoFrontend}/some-unknown-route`);
  expect(res.status).toBe(404);
  const ct = res.headers.get("content-type") ?? "";
  expect(ct).toContain("application/json");
});

// ─── Health check unaffected ──────────────────────────────────────────────

test("GET /health returns 200 JSON when frontend is enabled", async () => {
  const res = await fetch(`${baseWithFrontend}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.status).toBe("ok");
});
