/**
 * Integration tests for realtime WebSocket support.
 * Uses real HTTP servers on port 0 and Bun's native WebSocket client.
 */
import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../core/server.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

// ─── Schema ───────────────────────────────────────────────────────────────────

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id"),
});

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const root = join(tmpdir(), `tsbase-rt-intg-${Date.now()}`);
mkdirSync(root, { recursive: true });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps a WebSocket and buffers all incoming messages.
 * `next()` checks the buffer first, then waits for future messages.
 */
function createWsHelper(ws: WebSocket) {
  const buffer: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (msg: Record<string, unknown>) => boolean;
    resolve: (msg: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data as string) as Record<string, unknown>;

    // Check waiters first — if one matches, it consumes the message (not buffered).
    // This ensures helper.buffer contains only unconsumed messages, so the test can
    // assert absence of duplicates without also seeing the expected events.
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(msg)) {
        const [{ resolve, timer }] = waiters.splice(i, 1);
        clearTimeout(timer);
        resolve(msg);
        return; // consumed — do NOT add to buffer
      }
    }

    // No waiter matched — park in buffer for later inspection
    buffer.push(msg);
  });

  function next(
    predicate?: (msg: Record<string, unknown>) => boolean,
    timeout = 3000,
  ): Promise<Record<string, unknown>> {
    const pred = predicate ?? (() => true);

    // Check buffer first (message might have already arrived)
    const idx = buffer.findIndex(pred);
    if (idx !== -1) {
      const [msg] = buffer.splice(idx, 1);
      return Promise.resolve(msg);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`WsHelper.next: timeout waiting for message`));
      }, timeout);
      waiters.push({ predicate: pred, resolve, timer });
    });
  }

  return { next, buffer };
}

/** Wait for WS to be in OPEN state */
function waitForOpen(ws: WebSocket, timeout = 3000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForOpen: timeout")), timeout);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(e); }, { once: true });
  });
}

/** Wait for WS to reach CLOSED state */
function waitForClose(ws: WebSocket, timeout = 3000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    ws.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// ─── DB seed helpers ──────────────────────────────────────────────────────────

async function seedUser(
  adapter: any,
  id: string,
  email: string,
  sessionId: string,
): Promise<void> {
  // Use a dummy hash (no real password validation needed for WS auth tests)
  const hash = "$2b$10$fakehashfakehashfakehashfakehash00000000000";
  await adapter.rawExecute(
    "INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES ($id, $email, $hash, $role)",
    { $id: id, $email: email, $hash: hash, $role: "user" },
  );
  const expiresAt = Math.floor(Date.now() / 1000) + 7200;
  await adapter.rawExecute(
    "INSERT OR IGNORE INTO _sessions (id, user_id, expires_at, created_at) VALUES ($id, $userId, $expiresAt, $createdAt)",
    { $id: sessionId, $userId: id, $expiresAt: expiresAt, $createdAt: new Date().toISOString() },
  );
}

// ─── Server setup ─────────────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve>;
let tsbase: ReturnType<typeof createServer>;
let base: string;
let wsBase: string;
let userAId: string;
let userASession: string;
let userBId: string;
let userBSession: string;
let latestListRuleArg: any = null;

const CSRF = "rt-test-csrf";
const csrfHeaders = { "x-csrf-token": CSRF, cookie: `csrf_token=${CSRF}` };

function csrfHeadersWithSession(sessionId: string) {
  return { "x-csrf-token": CSRF, cookie: `csrf_token=${CSRF}; tsbase_session=${sessionId}` };
}

// ownerOnly rule: only see rows where ownerId === auth.id
function ownerOnly(arg: any) {
  latestListRuleArg = arg;
  if (!arg?.auth) return false;
  return eq(tasks.ownerId, arg.auth.id);
}

const dbPath = join(root, "rt.sqlite");

beforeAll(async () => {
  tsbase = createServer({
    schema: { tasks, users },
    rules: {
      tasks: {
        list: ownerOnly,
        create: ({ auth }) => auth !== null,
        update: ({ auth }) => auth !== null,
        delete: ({ auth }) => auth !== null,
      },
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
      realtime: { enabled: true },
    }),
  });

  await tsbase.adapter.rawExecute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    )
  `);
  await tsbase.adapter.rawExecute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id TEXT
    )
  `);

  server = tsbase.listen(0);
  base = server.url.toString().replace(/\/$/, "");
  wsBase = base.replace(/^http/, "ws");

  // Seed two users with sessions — avoids auth endpoint / rate-limiter issues
  userAId = "user-a-id";
  userASession = "session-a";
  userBId = "user-b-id";
  userBSession = "session-b";

  await seedUser(tsbase.adapter, userAId, "usera@test.com", userASession);
  await seedUser(tsbase.adapter, userBId, "userb@test.com", userBSession);
});

afterAll(() => {
  server?.stop(true);
  tsbase?.adapter.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── Test: Unauthenticated subscribe to public table ─────────────────────────

test("unauthenticated client subscribes to table with no ownerOnly → denied by rule", async () => {
  // ownerOnly rule returns false when auth is null → denied
  const ws = new WebSocket(`${wsBase}/realtime`);
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  const msg = await helper.next((m) => m.type === "error");
  expect(msg.message).toMatch(/access denied/i);

  ws.close();
  await waitForClose(ws);
});

test("realtime subscribe passes RuleArg defaults to list rule", async () => {
  latestListRuleArg = null;
  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(100);

  expect(latestListRuleArg).not.toBeNull();
  expect(latestListRuleArg.auth.id).toBe(userAId);
  expect(latestListRuleArg.method).toBe("SUBSCRIBE");
  expect(latestListRuleArg.body).toEqual({});
  expect(latestListRuleArg.headers).toEqual({});
  expect(latestListRuleArg.query).toEqual({});
  expect(typeof latestListRuleArg.db).toBe("object");

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Authenticated subscribe and receive table events ──────────────────

test("auth client receives INSERT, UPDATE, DELETE events for own tasks", async () => {
  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(100); // ensure subscription registered

  // INSERT
  const insertPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).action === "INSERT" && (m as any).id === "ta-e2e-1",
  );
  const createRes = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-e2e-1", title: "My Task", ownerId: userAId }),
  });
  expect(createRes.status).toBe(201);
  const insertMsg = await insertPromise;
  expect(insertMsg.action).toBe("INSERT");
  expect((insertMsg.record as any).title).toBe("My Task");

  // UPDATE
  const updatePromise = helper.next(
    (m) => m.type === "table:change" && (m as any).action === "UPDATE" && (m as any).id === "ta-e2e-1",
  );
  await fetch(`${base}/api/tasks/ta-e2e-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ title: "Updated Task" }),
  });
  const updateMsg = await updatePromise;
  expect(updateMsg.action).toBe("UPDATE");
  expect((updateMsg.record as any).title).toBe("Updated Task");

  // DELETE
  const deletePromise = helper.next(
    (m) => m.type === "table:change" && (m as any).action === "DELETE" && (m as any).id === "ta-e2e-1",
  );
  await fetch(`${base}/api/tasks/ta-e2e-1`, {
    method: "DELETE",
    headers: csrfHeadersWithSession(userASession),
  });
  const deleteMsg = await deletePromise;
  expect(deleteMsg.action).toBe("DELETE");
  expect(deleteMsg.id).toBe("ta-e2e-1");
  // Filtered DELETE now includes the record
  expect(typeof deleteMsg.record).toBe("object");

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Filtered — INSERT other's task → no event ─────────────────────────

test("filtered subscriber does not receive INSERT of another user's task", async () => {
  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(100);

  // Insert B's task — A should NOT receive it
  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userBSession) },
    body: JSON.stringify({ id: "tb-other-2", title: "Bob's task", ownerId: userBId }),
  });

  // Insert A's task — A SHOULD receive it (used as sentinel)
  const sentinelPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-sentinel-2",
  );
  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-sentinel-2", title: "Sentinel", ownerId: userAId }),
  });
  await sentinelPromise;

  // Verify Bob's task never arrived
  const bobMsg = helper.buffer.find((m) => (m as any).id === "tb-other-2");
  expect(bobMsg).toBeUndefined();

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Filtered — UPDATE visible→invisible → synthetic DELETE ─────────────

test("filtered subscriber receives synthetic DELETE when visible row becomes invisible", async () => {
  // Seed a task owned by A
  await tsbase.adapter.rawExecute(
    `INSERT OR IGNORE INTO tasks (id, title, owner_id) VALUES ('ta-vis-1', 'Visible', '${userAId}')`,
  );

  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(150); // ensure visibleIds seeded

  // Transfer ownership to B — row leaves A's filter
  const deletePromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-vis-1",
  );
  await fetch(`${base}/api/tasks/ta-vis-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ ownerId: userBId }),
  });

  const msg = await deletePromise;
  expect(msg.action).toBe("DELETE");
  expect(msg.id).toBe("ta-vis-1");
  // Synthetic DELETE (visible→invisible): record is omitted to avoid leaking hidden data
  expect(msg.record).toBeUndefined();

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Filtered — UPDATE invisible→visible → UPDATE with full record ──────

test("filtered subscriber receives UPDATE when invisible row becomes visible", async () => {
  // Seed a task owned by B (invisible to A)
  await tsbase.adapter.rawExecute(
    `INSERT OR IGNORE INTO tasks (id, title, owner_id) VALUES ('tb-invis-1', 'B Invisible', '${userBId}')`,
  );

  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(150);

  // Transfer to A — should appear as UPDATE with full record
  const updatePromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "tb-invis-1",
  );
  await fetch(`${base}/api/tasks/tb-invis-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userBSession) },
    body: JSON.stringify({ ownerId: userAId }),
  });

  const msg = await updatePromise;
  expect(msg.action).toBe("UPDATE");
  expect(msg.id).toBe("tb-invis-1");
  expect((msg.record as any).ownerId).toBe(userAId);

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Filtered — UPDATE invisible→invisible → no event ──────────────────

test("filtered subscriber receives no event when invisible row updated but stays invisible", async () => {
  // Seed a task owned by B
  await tsbase.adapter.rawExecute(
    `INSERT OR IGNORE INTO tasks (id, title, owner_id) VALUES ('tb-invis-2', 'B Stay Invis', '${userBId}')`,
  );

  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(150);

  // Update B's task without changing owner — stays invisible to A
  await fetch(`${base}/api/tasks/tb-invis-2`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userBSession) },
    body: JSON.stringify({ title: "B Stay Invis Updated" }),
  });

  // Insert A's task as sentinel
  const sentinelPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-sentinel-invis",
  );
  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-sentinel-invis", title: "Sentinel", ownerId: userAId }),
  });
  await sentinelPromise;

  // Verify B's invisible update never arrived
  const bobMsg = helper.buffer.find((m) => (m as any).id === "tb-invis-2");
  expect(bobMsg).toBeUndefined();

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Filtered — DELETE own visible task → DELETE id only ────────────────

test("filtered subscriber receives DELETE id-only when previously visible task deleted", async () => {
  // Seed a task for A
  await tsbase.adapter.rawExecute(
    `INSERT OR IGNORE INTO tasks (id, title, owner_id) VALUES ('ta-del-1', 'A Delete', '${userAId}')`,
  );

  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(150); // wait for visibleIds seed

  const delPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-del-1",
  );
  await fetch(`${base}/api/tasks/ta-del-1`, {
    method: "DELETE",
    headers: csrfHeadersWithSession(userASession),
  });

  const msg = await delPromise;
  expect(msg.action).toBe("DELETE");
  expect(msg.id).toBe("ta-del-1");
  // Filtered DELETE now includes the record
  expect(typeof msg.record).toBe("object");

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Filtered — DELETE other's task (never visible) → no event ─────────

test("filtered subscriber receives no event when another user's task deleted", async () => {
  await tsbase.adapter.rawExecute(
    `INSERT OR IGNORE INTO tasks (id, title, owner_id) VALUES ('tb-del-2', 'B Delete', '${userBId}')`,
  );

  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(150);

  await fetch(`${base}/api/tasks/tb-del-2`, {
    method: "DELETE",
    headers: csrfHeadersWithSession(userBSession),
  });

  // Sentinel
  const sentinelPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-sentinel-del",
  );
  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-sentinel-del", title: "Sentinel", ownerId: userAId }),
  });
  await sentinelPromise;

  expect(helper.buffer.find((m) => (m as any).id === "tb-del-2")).toBeUndefined();

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Broadcast channels ─────────────────────────────────────────────────

test("two auth clients subscribe to channel and receive broadcasts from each other", async () => {
  const wsA = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  const wsB = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userBSession}` },
  });
  await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

  const helperA = createWsHelper(wsA);
  const helperB = createWsHelper(wsB);

  wsA.send(JSON.stringify({ type: "subscribe:broadcast", channel: "room:123" }));
  wsB.send(JSON.stringify({ type: "subscribe:broadcast", channel: "room:123" }));
  await delay(50);

  // A broadcasts — both should receive
  const aPromise = helperA.next((m) => m.type === "broadcast" && (m as any).event === "ping");
  const bPromise = helperB.next((m) => m.type === "broadcast" && (m as any).event === "ping");

  wsA.send(
    JSON.stringify({ type: "broadcast", channel: "room:123", event: "ping", payload: { from: "A" } }),
  );

  const [msgA, msgB] = await Promise.all([aPromise, bPromise]);
  expect(msgA.event).toBe("ping");
  expect((msgA.payload as any).from).toBe("A");
  expect(msgB.event).toBe("ping");

  wsA.close();
  wsB.close();
  await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
});

test("unauthenticated client receives error on broadcast attempt", async () => {
  const ws = new WebSocket(`${wsBase}/realtime`);
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:broadcast", channel: "room:1" }));
  const msg = await helper.next((m) => m.type === "error");
  expect(msg.message).toMatch(/authentication required/i);

  ws.close();
  await waitForClose(ws);
});

// ─── Test: broadcast() queued before WS open is delivered (P2) ────────────────
//
// channel.broadcast() in client.ts uses sendWhenReady(), which registers an
// open-event listener when the socket is still connecting. This test proves
// that pattern delivers the message — i.e. that the former bug (using send()
// which silently dropped pre-open messages) is fixed.

test("broadcast message queued before WS open is delivered after connect", async () => {
  // Receiver: already connected and subscribed to the channel
  const receiver = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userBSession}` },
  });
  await waitForOpen(receiver);
  const helperReceiver = createWsHelper(receiver);
  receiver.send(JSON.stringify({ type: "subscribe:broadcast", channel: "pre-open-ch" }));
  await delay(50);

  // Register the expectation BEFORE the sender even connects, so we never
  // miss the message regardless of how fast the delivery is.
  const broadcastArrived = helperReceiver.next(
    (m) => m.type === "broadcast" && (m as any).event === "pre-open-msg",
    3000,
  );

  // Sender: create WS but enqueue subscribe + broadcast in the open handler
  // without awaiting open first. This is the exact mechanism sendWhenReady()
  // uses in client.ts — messages are appended to the open event and sent the
  // moment the socket handshake completes.
  const sender = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  sender.addEventListener(
    "open",
    () => {
      sender.send(JSON.stringify({ type: "subscribe:broadcast", channel: "pre-open-ch" }));
      sender.send(
        JSON.stringify({
          type: "broadcast",
          channel: "pre-open-ch",
          event: "pre-open-msg",
          payload: { queued: true },
        }),
      );
    },
    { once: true },
  );

  const msg = await broadcastArrived;
  expect(msg.event).toBe("pre-open-msg");
  expect((msg.payload as any).queued).toBe(true);

  sender.close();
  receiver.close();
  await Promise.all([waitForClose(sender), waitForClose(receiver)]);
});

// ─── Test: Presence ──────────────────────────────────────────────────────────

test("presence — join emits state to joiner and join event to others", async () => {
  const wsA = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  const wsB = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userBSession}` },
  });
  await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

  const helperA = createWsHelper(wsA);
  const helperB = createWsHelper(wsB);

  // B joins first
  wsB.send(JSON.stringify({ type: "subscribe:presence", channel: "lobby", meta: { name: "Bob" } }));
  const stateB = await helperB.next((m) => m.type === "presence:state");
  expect(stateB.channel).toBe("lobby");

  // A joins — B should see join event, A should see state
  const aStatePromise = helperA.next((m) => m.type === "presence:state");
  const bJoinPromise = helperB.next((m) => m.type === "presence:join");

  wsA.send(JSON.stringify({ type: "subscribe:presence", channel: "lobby", meta: { name: "Alice" } }));

  const [stateA, joinB] = await Promise.all([aStatePromise, bJoinPromise]);
  expect((stateA as any).users.length).toBeGreaterThanOrEqual(1);
  expect((joinB as any).user.userId).toBe(userAId);
  expect((joinB as any).user.meta.name).toBe("Alice");

  // A leaves explicitly
  const bLeavePromise = helperB.next((m) => m.type === "presence:leave");
  wsA.send(JSON.stringify({ type: "unsubscribe:presence", channel: "lobby" }));
  const leaveB = await bLeavePromise;
  expect((leaveB as any).userId).toBe(userAId);

  wsA.close();
  wsB.close();
  await Promise.all([waitForClose(wsA), waitForClose(wsB)]);
});

test("presence — disconnect without explicit unsubscribe emits leave to others", async () => {
  const wsA = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  const wsB = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userBSession}` },
  });
  await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);

  const helperA = createWsHelper(wsA);
  const helperB = createWsHelper(wsB);

  // B joins the channel to observe
  wsB.send(JSON.stringify({ type: "subscribe:presence", channel: "lobby2" }));
  await helperB.next((m) => m.type === "presence:state");

  // A joins
  wsA.send(JSON.stringify({ type: "subscribe:presence", channel: "lobby2", meta: {} }));
  await helperB.next((m) => m.type === "presence:join");

  // A disconnects without explicit leave
  const bLeavePromise = helperB.next((m) => m.type === "presence:leave");
  wsA.close();
  const leaveMsg = await bLeavePromise;
  expect((leaveMsg as any).userId).toBe(userAId);

  wsB.close();
  await waitForClose(wsB);
});

test("unauthenticated client receives error on presence attempt", async () => {
  const ws = new WebSocket(`${wsBase}/realtime`);
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:presence", channel: "lobby" }));
  const msg = await helper.next((m) => m.type === "error");
  expect(msg.message).toMatch(/authentication required/i);

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Unknown table ───────────────────────────────────────────────────────

test("subscribing to unknown table returns error", async () => {
  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "nonexistent" }));
  const msg = await helper.next((m) => m.type === "error");
  expect(msg.message).toMatch(/unknown table/i);

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Unsubscribe stops events ───────────────────────────────────────────

test("after unsubscribe, no further table change events received", async () => {
  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(100);

  // Insert a task to verify subscription works
  const insertPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-unsub-1",
  );
  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-unsub-1", title: "Before Unsub", ownerId: userAId }),
  });
  await insertPromise;

  // Unsubscribe
  ws.send(JSON.stringify({ type: "unsubscribe:table", table: "tasks" }));
  await delay(50);

  const initialBufferLen = helper.buffer.length;

  // Insert another task — should NOT arrive
  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-unsub-2", title: "After Unsub", ownerId: userAId }),
  });
  await delay(200);

  expect(helper.buffer.length).toBe(initialBufferLen);

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Duplicate subscribe:table idempotency (P1) ────────────────────────

test("duplicate subscribe:table messages are idempotent — exactly one event per mutation", async () => {
  const ws = new WebSocket(`${wsBase}/realtime`, {
    headers: { cookie: `tsbase_session=${userASession}` },
  });
  await waitForOpen(ws);
  const helper = createWsHelper(ws);

  // Send subscribe:table TWICE — the second must be a no-op (manager.ts guard)
  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  ws.send(JSON.stringify({ type: "subscribe:table", table: "tasks" }));
  await delay(100); // ensure both subscription messages are processed

  // Insert two tasks. With a duplicate subscriber each INSERT would fire two events;
  // with the idempotency guard it must fire exactly one each.
  const firstPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-dup-1",
  );
  const secondPromise = helper.next(
    (m) => m.type === "table:change" && (m as any).id === "ta-dup-2",
  );

  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-dup-1", title: "Dup Test 1", ownerId: userAId }),
  });
  await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeadersWithSession(userASession) },
    body: JSON.stringify({ id: "ta-dup-2", title: "Dup Test 2", ownerId: userAId }),
  });

  // Consume the expected events
  await Promise.all([firstPromise, secondPromise]);

  // Wait for any extra duplicate events that would arrive with a buggy implementation
  await delay(150);

  // helper.next() already removed the two expected messages from the buffer.
  // A duplicate subscriber would leave one extra copy of each — assert none remain.
  const duplicates = helper.buffer.filter(
    (m) =>
      m.type === "table:change" &&
      ((m as any).id === "ta-dup-1" || (m as any).id === "ta-dup-2"),
  );
  expect(duplicates.length).toBe(0);

  ws.close();
  await waitForClose(ws);
});

// ─── Test: Realtime disabled ──────────────────────────────────────────────────

test("realtime disabled — /realtime returns 404", async () => {
  const dbPath5 = join(root, "rt-disabled.sqlite");
  const disabledTsbase = createServer({
    schema: { tasks },
    config: makeResolvedConfig({
      development: true,
      database: { driver: "sqlite", url: dbPath5 },
      dbPath: dbPath5,
      storage: {
        driver: "local" as const,
        localPath: join(root, "uploads-disabled"),
        maxFileSize: 10 * 1024 * 1024,
      },
      migrationsPath: join(root, "drizzle-disabled"),
      // realtime not enabled (default false)
    }),
  });
  await disabledTsbase.adapter.rawExecute(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id TEXT)",
  );
  const disabledServer = disabledTsbase.listen(0);
  const disabledBase = disabledServer.url.toString().replace(/\/$/, "");

  try {
    const res = await fetch(`${disabledBase}/realtime`);
    expect(res.status).toBe(404);
  } finally {
    disabledServer.stop(true);
    disabledTsbase.adapter.close();
  }
});
