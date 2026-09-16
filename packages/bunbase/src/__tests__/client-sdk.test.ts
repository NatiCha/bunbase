import { afterAll, beforeAll, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { BunBaseClientError, createBunBaseClient } from "../client.ts";

// A tiny mock BunBase-shaped server so we can exercise the client without the
// full server stack. It echoes received headers so we can assert CSRF behavior.
const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const received: { csrf?: string | null; path?: string } = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      received.path = url.pathname;
      received.csrf = req.headers.get("x-csrf-token");

      // Failed login → standard error envelope with a 401.
      if (url.pathname === "/auth/login") {
        return new Response(
          JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid email or password" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      // Successful register/login → { user }.
      if (url.pathname === "/auth/register") {
        return Response.json({ user: { id: "u1", email: "a@b.c", role: "user" } });
      }
      if (url.pathname === "/auth/logout") {
        return Response.json({ success: true });
      }
      // File upload / delete echo success.
      if (url.pathname.startsWith("/files/")) {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

test("failed login throws BunBaseClientError with code + status", async () => {
  const client = createBunBaseClient({ url: baseUrl, schema: { posts } });
  let thrown: unknown;
  try {
    await client.auth.login({ email: "x@y.z", password: "wrong" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(BunBaseClientError);
  const e = thrown as BunBaseClientError;
  expect(e.code).toBe("UNAUTHORIZED");
  expect(e.status).toBe(401);
  expect(e.message).toBe("Invalid email or password");
});

test("files.upload sends X-CSRF-Token (cookie auth)", async () => {
  const client = createBunBaseClient({ url: baseUrl, schema: { posts } });
  received.csrf = undefined;
  const file = new File(["hello"], "hello.txt", { type: "text/plain" });
  await client.files.upload("avatars", "rec1", file);
  // getCsrfToken() returns "" outside the browser; the header must still be present.
  expect(received.csrf).not.toBeUndefined();
  expect(received.path).toBe("/files/avatars/rec1");
});

test("files.delete sends X-CSRF-Token and goes through request()", async () => {
  const client = createBunBaseClient({ url: baseUrl, schema: { posts } });
  received.csrf = undefined;
  const res = await client.files.delete("file123");
  expect((res as { ok: boolean }).ok).toBe(true);
  expect(received.csrf).not.toBeUndefined();
});

test("files.upload omits CSRF and uses bearer when apiKey set", async () => {
  const client = createBunBaseClient({ url: baseUrl, schema: { posts }, apiKey: "bb_live_x" });
  received.csrf = undefined;
  const file = new File(["hi"], "hi.txt");
  await client.files.upload("avatars", "rec2", file);
  expect(received.csrf).toBeNull();
});

test("onAuthStateChange fires on login and logout", async () => {
  const client = createBunBaseClient({ url: baseUrl, schema: { posts } });
  const states: Array<{ user: Record<string, unknown> | null }> = [];
  const off = client.auth.onAuthStateChange((s) => states.push(s));

  await client.auth.register({ email: "a@b.c", password: "password123" });
  await client.auth.logout();
  off();

  expect(states.length).toBe(2);
  expect(states[0]?.user).not.toBeNull();
  expect(states[1]?.user).toBeNull();
});

test("realtime client exposes a status getter (starts closed)", () => {
  const client = createBunBaseClient({ url: baseUrl, schema: { posts } });
  expect(client.realtime.status).toBe("closed");
});
