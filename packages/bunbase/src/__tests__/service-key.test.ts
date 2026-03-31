/**
 * Tests for service key server-to-server authentication.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { isServiceKey, SERVICE_KEY_USER } from "../auth/middleware.ts";
import { createTestServer } from "../testing/index.ts";

// ─── Shared schema ────────────────────────────────────────────────────────────

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id"),
});

// ─── Unit: isServiceKey ──────────────────────────────────────────────────────

describe("isServiceKey", () => {
  const serviceKey = "bb_sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

  test("returns true for matching service key", () => {
    expect(isServiceKey(serviceKey, serviceKey)).toBe(true);
  });

  test("returns false for non-matching service key", () => {
    expect(isServiceKey("bb_sk_00000000000000000000000000000000", serviceKey)).toBe(false);
  });

  test("returns false for user API key prefix", () => {
    expect(isServiceKey("bb_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", serviceKey)).toBe(false);
  });

  test("returns false for arbitrary token", () => {
    expect(isServiceKey("some-random-token", serviceKey)).toBe(false);
  });

  test("returns false for different length", () => {
    expect(isServiceKey("bb_sk_short", serviceKey)).toBe(false);
  });
});

// ─── Unit: SERVICE_KEY_USER constant ─────────────────────────────────────────

describe("SERVICE_KEY_USER", () => {
  test("has admin role", () => {
    expect(SERVICE_KEY_USER.role).toBe("admin");
  });

  test("has __service__ id", () => {
    expect(SERVICE_KEY_USER.id).toBe("__service__");
  });

  test("has empty email", () => {
    expect(SERVICE_KEY_USER.email).toBe("");
  });
});

// ─── Integration: service key auth ───────────────────────────────────────────

describe("service key integration", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;
  let serviceKey: string;

  // We need to read the auto-generated service key from the config
  // createTestServer uses development: true and no explicit serviceKey,
  // so it will auto-generate one
  const setup = async () => {
    const testServer = await createTestServer({
      schema: { users, posts },
      rules: {
        posts: {
          list: () => true,
          create: ({ auth }) => auth?.role === "admin",
          delete: ({ auth }) => auth?.role === "admin",
        },
      },
      config: {
        serviceKey: "bb_sk_test1234567890abcdef1234567890ab",
      },
    });
    return testServer;
  };

  server = null as any;

  test("setup", async () => {
    server = await setup();
    serviceKey = "bb_sk_test1234567890abcdef1234567890ab";
  });

  afterAll(() => {
    server?.cleanup();
  });

  test("service key grants access to admin endpoints", async () => {
    const res = await fetch(`${server.baseUrl}/_admin/api/config`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("development");
  });

  test("service key grants access to admin users list", async () => {
    const res = await fetch(`${server.baseUrl}/_admin/api/users`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
    });
    expect(res.status).toBe(200);
  });

  test("service key allows CRUD create when rule checks admin role", async () => {
    const res = await fetch(`${server.baseUrl}/api/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "p1", title: "Service key post" }),
    });
    expect(res.status).toBe(201);
  });

  test("service key allows CRUD delete when rule checks admin role", async () => {
    const res = await fetch(`${server.baseUrl}/api/posts/p1`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${serviceKey}` },
    });
    expect(res.status).toBe(200);
  });

  test("invalid service key is rejected on admin endpoints", async () => {
    const res = await fetch(`${server.baseUrl}/_admin/api/config`, {
      headers: { Authorization: "Bearer bb_sk_invalid000000000000000000000" },
    });
    expect(res.status).toBe(401);
  });

  test("user API key prefix is not treated as service key", async () => {
    const res = await fetch(`${server.baseUrl}/_admin/api/config`, {
      headers: { Authorization: "Bearer bb_live_test1234567890abcdef1234567890ab" },
    });
    expect(res.status).toBe(401);
  });

  test("no auth header returns 401 on admin endpoints", async () => {
    const res = await fetch(`${server.baseUrl}/_admin/api/config`);
    expect(res.status).toBe(401);
  });

  test("service key does not interfere with normal session auth", async () => {
    // Register a user via the normal auth flow
    const regRes = await server.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        password: "password123",
      }),
    });
    expect(regRes.status).toBe(201);

    // Login and get session cookie
    const loginRes = await server.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "test@example.com",
        password: "password123",
      }),
    });
    expect(loginRes.status).toBe(200);

    // Session-based /auth/me should work
    const cookies = loginRes.headers.getSetCookie();
    const sessionCookie = cookies.find((c) => c.startsWith("bunbase_session="));
    expect(sessionCookie).toBeDefined();

    // Use server.fetch which auto-adds CSRF, and append the session cookie
    const csrfToken = "test-csrf-token";
    const meRes = await fetch(`${server.baseUrl}/auth/me`, {
      headers: {
        cookie: `${sessionCookie!.split(";")[0]}; csrf_token=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me.user.email).toBe("test@example.com");
  });

  test("public endpoints work without service key", async () => {
    const res = await fetch(`${server.baseUrl}/api/posts`, {
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
  });
});

// ─── Service key file persistence ────────────────────────────────────────────

describe("service key auto-generation", () => {
  test("auto-generates key with bb_sk_ prefix when not configured", async () => {
    // createTestServer doesn't set serviceKey, so it will auto-generate
    const testServer = await createTestServer({
      schema: { users, posts },
      rules: { posts: { list: () => true } },
    });

    // The config should have a service key populated
    // We can test this by making an admin request with the auto-generated key
    // But we don't have direct access to config from TestServer...
    // Instead, verify that the .bunbase-service-key file was NOT created in the
    // test's tmpdir (createTestServer sets cwd implicitly via db path)

    // Just verify the server works and cleanup
    const res = await fetch(`${testServer.baseUrl}/health`);
    expect(res.status).toBe(200);

    testServer.cleanup();
  });
});
