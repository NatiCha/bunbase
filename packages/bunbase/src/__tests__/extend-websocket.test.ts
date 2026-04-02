/**
 * Integration tests for WebSocket support in the extend system.
 * Uses real HTTP servers on port 0 and Bun's native WebSocket client.
 */

// Bun's WebSocket client accepts { headers } as a second argument, but the
// standard lib.dom.d.ts only allows string | string[] for the protocols param.
// @ts-nocheck
/* eslint-disable */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createServer, defineWebSocket } from "../core/server.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

// ─── Schema ───────────────────────────────────────────────────────────────────

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForOpen(ws: WebSocket, timeout = 3000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForOpen: timeout")), timeout);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
      { once: true },
    );
  });
}

function waitForClose(ws: WebSocket, timeout = 3000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function waitForMessage(ws: WebSocket, timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForMessage: timeout")), timeout);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event.data as string);
      },
      { once: true },
    );
  });
}

// ─── Server setup ─────────────────────────────────────────────────────────────

const root = join(tmpdir(), `bunbase-ws-extend-${Date.now()}`);
mkdirSync(root, { recursive: true });
const dbPath = join(root, "db.sqlite");

let server: ReturnType<typeof Bun.serve>;
let base: string;
let wsBase: string;

// Track lifecycle events for assertions
const events: string[] = [];

beforeAll(async () => {
  const bunbase = createServer({
    schema: { users },
    rules: {},
    config: makeResolvedConfig({
      database: { driver: "sqlite", url: dbPath },
      development: true,
    }),
    extend: (_ctx) => ({
      // Basic echo WebSocket — no upgrade function
      "/echo": {
        websocket: defineWebSocket({
          open(_ws) {
            events.push("echo:open");
          },
          message(ws, message) {
            events.push("echo:message");
            ws.send(`echo:${message}`);
          },
          close(_ws, _code, _reason) {
            events.push("echo:close");
          },
        }),
      },
      // WebSocket with typed data from upgrade()
      "/bridge": {
        websocket: defineWebSocket({
          async upgrade(req) {
            const url = new URL(req.url);
            const token = url.searchParams.get("token");
            if (token === "reject") {
              return new Response("Forbidden", { status: 403 });
            }
            return { deviceId: token ?? "default", counter: 0 };
          },
          open(ws) {
            events.push(`bridge:open:${ws.data.deviceId}`);
          },
          message(ws, _message) {
            ws.data.counter++;
            ws.send(JSON.stringify({ deviceId: ws.data.deviceId, count: ws.data.counter }));
          },
          close(ws, _code, _reason) {
            events.push(`bridge:close:${ws.data.deviceId}`);
          },
        }),
      },
      // Mixed: HTTP + WebSocket on same path
      "/api/hybrid": {
        GET: (_req) => Response.json({ type: "http" }),
        websocket: defineWebSocket({
          message(ws, _message) {
            ws.send("hybrid-ws");
          },
        }),
      },
      // Unscoped routes — outside /api/, no CSRF
      "/.well-known/test": {
        unscoped: true,
        GET: () => Response.json({ ok: true }),
      },
      "/token": {
        unscoped: true,
        POST: () => Response.json({ granted: true }),
      },
    }),
  });

  server = bunbase.listen(0);
  base = String(server.url).replace(/\/$/, "");
  wsBase = base.replace(/^http/, "ws");

  // Wait for bootstrap
  await delay(200);
});

afterAll(() => {
  server?.stop();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("basic WebSocket lifecycle — open, message, close", async () => {
  events.length = 0;
  const ws = new WebSocket(`${wsBase}/echo`);
  await waitForOpen(ws);

  ws.send("hello");
  const reply = await waitForMessage(ws);
  expect(reply).toBe("echo:hello");

  ws.close();
  await waitForClose(ws);
  await delay(50);

  expect(events).toContain("echo:open");
  expect(events).toContain("echo:message");
  expect(events).toContain("echo:close");
});

test("upgrade() attaches typed data to ws.data", async () => {
  events.length = 0;
  const ws = new WebSocket(`${wsBase}/bridge?token=device-42`);
  await waitForOpen(ws);

  ws.send("ping");
  const reply = JSON.parse(await waitForMessage(ws));
  expect(reply.deviceId).toBe("device-42");
  expect(reply.count).toBe(1);

  // Second message increments counter
  ws.send("ping");
  const reply2 = JSON.parse(await waitForMessage(ws));
  expect(reply2.count).toBe(2);

  ws.close();
  await waitForClose(ws);
  await delay(50);

  expect(events).toContain("bridge:open:device-42");
  expect(events).toContain("bridge:close:device-42");
});

test("upgrade() returning Response rejects the connection", async () => {
  const res = await fetch(`${base}/bridge?token=reject`, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": btoa(crypto.randomUUID()),
      "Sec-WebSocket-Version": "13",
    },
  });
  expect(res.status).toBe(403);
  const text = await res.text();
  expect(text).toBe("Forbidden");
});

test("optional upgrade — omitting upgrade() still works", async () => {
  // /echo has no upgrade function — should connect with empty data
  const ws = new WebSocket(`${wsBase}/echo`);
  await waitForOpen(ws);

  ws.send("test");
  const reply = await waitForMessage(ws);
  expect(reply).toBe("echo:test");

  ws.close();
  await waitForClose(ws);
});

test("WebSocket path does not require /api/ prefix", async () => {
  // /echo and /bridge are not under /api/ — they should work
  const ws = new WebSocket(`${wsBase}/echo`);
  await waitForOpen(ws);
  ws.close();
  await waitForClose(ws);
});

test("mixed HTTP + WebSocket on same path", async () => {
  // HTTP GET should work
  const httpRes = await fetch(`${base}/api/hybrid`);
  expect(httpRes.status).toBe(200);
  const json = await httpRes.json();
  expect(json.type).toBe("http");

  // WebSocket should also work on the same path
  const ws = new WebSocket(`${wsBase}/api/hybrid`);
  await waitForOpen(ws);

  ws.send("hello");
  const reply = await waitForMessage(ws);
  expect(reply).toBe("hybrid-ws");

  ws.close();
  await waitForClose(ws);
});

test("HTTP-only extend routes still require /api/ prefix", () => {
  expect(() => {
    createServer({
      schema: { users },
      rules: {},
      config: makeResolvedConfig({
        database: { driver: "sqlite", url: ":memory:" },
        development: true,
      }),
      extend: () => ({
        "/custom": {
          GET: () => new Response("nope"),
        },
      }),
    });
  }).toThrow(/extend routes must be under \/api\//);
});

test("error message mentions unscoped opt-out", () => {
  expect(() => {
    createServer({
      schema: { users },
      rules: {},
      config: makeResolvedConfig({
        database: { driver: "sqlite", url: ":memory:" },
        development: true,
      }),
      extend: () => ({
        "/custom": {
          GET: () => new Response("nope"),
        },
      }),
    });
  }).toThrow(/unscoped: true/);
});

test("cannot override /realtime WebSocket path", () => {
  expect(() => {
    createServer({
      schema: { users },
      rules: {},
      config: makeResolvedConfig({
        database: { driver: "sqlite", url: ":memory:" },
        development: true,
      }),
      extend: () => ({
        "/realtime": {
          websocket: defineWebSocket({
            message() {},
          }),
        },
      }),
    });
  }).toThrow(/Cannot override built-in \/realtime/);
});

// ─── Unscoped routes ──────────────────────────────────────────────────────────

test("unscoped route outside /api/ works", async () => {
  const res = await fetch(`${base}/.well-known/test`);
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.ok).toBe(true);
});

test("unscoped route does not require CSRF for POST", async () => {
  // POST without CSRF headers — should succeed because unscoped routes
  // are outside /api/ and CSRF only applies to /api/ paths
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "test" }),
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.granted).toBe(true);
});

test("unscoped route cannot collide with reserved paths", () => {
  const reservedPaths = ["/health", "/_admin/custom", "/auth/custom", "/realtime", "/files/test"];
  for (const path of reservedPaths) {
    expect(() => {
      createServer({
        schema: { users },
        rules: {},
        config: makeResolvedConfig({
          database: { driver: "sqlite", url: ":memory:" },
          development: true,
        }),
        extend: () => ({
          [path]: {
            unscoped: true,
            GET: () => new Response("nope"),
          },
        }),
      });
    }).toThrow(/collides with reserved path/);
  }
});
