import { afterAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { signJwt } from "../auth/jwt/core.ts";
import { extractAuth } from "../auth/middleware.ts";
import { resetRateLimit } from "../auth/rate-limit.ts";
import { createSession } from "../auth/sessions.ts";
import { allowAll } from "../rules/helpers.ts";
import { createTestServer } from "../testing/index.ts";
import { setupTestDb } from "./test-helpers.ts";

/**
 * Security-regression tests for the coordinated auth hardening pass.
 * Covers: registration emailVerified block, login timing equalisation,
 * change-password session/key revocation, and the MFA-required auth gate.
 * @module
 */

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  emailVerified: integer("email_verified").notNull().default(0),
});

const csrfToken = "test-csrf-token";

function extractSessionCookie(res: Response): string | null {
  for (const c of res.headers.getAll("set-cookie")) {
    if (c.startsWith("bunbase_session=")) return c.split(";")[0]!;
  }
  return null;
}

const server = await createTestServer({
  schema: { users },
  rules: { users: allowAll },
  config: { auth: { rateLimit: { max: 10000 } } },
});
afterAll(() => server.cleanup());
// Reclaim the shared rate-limit budget for later test files.
afterAll(() => resetRateLimit());

/**
 * Like `server.fetch`, but carries an explicit session cookie. `server.fetch`
 * overwrites the cookie header (CSRF only), so we hit the server directly here.
 */
function fetchWithSession(
  path: string,
  init: RequestInit = {},
  sessionCookie?: string | null,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("x-csrf-token", csrfToken);
  let cookieStr = `csrf_token=${csrfToken}`;
  if (sessionCookie) cookieStr += `; ${sessionCookie}`;
  headers.set("cookie", cookieStr);
  return globalThis.fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

// ─── Finding 2: registration cannot self-verify email ───

describe("registration mass-assignment", () => {
  test("emailVerified cannot be set at signup", async () => {
    const res = await server.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "selfverify@test.com",
        password: "password123",
        emailVerified: 1,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message.toLowerCase()).toContain("emailverified");
  });

  test("email_verified (snake_case) cannot be set at signup", async () => {
    const res = await server.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "selfverify2@test.com",
        password: "password123",
        email_verified: 1,
      }),
    });
    expect(res.status).toBe(400);
  });

  test("normal registration still succeeds and emailVerified defaults to 0", async () => {
    const res = await server.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "normal@test.com", password: "password123" }),
    });
    expect(res.status).toBe(201);
    const rows = await server.adapter.rawQuery<{ email_verified: number }>(
      "SELECT email_verified FROM users WHERE email = $email",
      { $email: "normal@test.com" },
    );
    expect(rows[0]?.email_verified).toBe(0);
  });
});

// ─── Finding 4: login timing equalisation (behavioural smoke) ───

describe("login does not short-circuit for missing accounts", () => {
  test("nonexistent account returns same 401 as wrong password", async () => {
    await server.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "real@test.com", password: "password123" }),
    });

    const missing = await server.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "ghost@test.com", password: "password123" }),
    });
    const wrong = await server.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "real@test.com", password: "wrongpassword" }),
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect((await missing.json()).error.message).toBe((await wrong.json()).error.message);
  });
});

// ─── Finding 3: voluntary password change revokes other sessions/keys ───

describe("change-password invalidates other sessions", () => {
  test("an old session is rejected after password change; current request gets a fresh session", async () => {
    // Register (session A) and log in again (session B) for the same user.
    const reg = await server.fetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "rotate@test.com", password: "password123" }),
    });
    const sessionA = extractSessionCookie(reg)!;

    const login = await server.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "rotate@test.com", password: "password123" }),
    });
    const sessionB = extractSessionCookie(login)!;

    // Both sessions are valid before the change.
    const meABefore = await fetchWithSession("/auth/me", {}, sessionA);
    expect(meABefore.status).toBe(200);

    // Change password using session B.
    const change = await fetchWithSession(
      "/auth/change-password",
      {
        method: "POST",
        body: JSON.stringify({ currentPassword: "password123", newPassword: "newpassword123" }),
      },
      sessionB,
    );
    expect(change.status).toBe(200);
    const freshSession = extractSessionCookie(change);
    expect(freshSession).not.toBeNull();

    // Session A (a different device) is now revoked.
    const meAAfter = await fetchWithSession("/auth/me", {}, sessionA);
    expect(meAAfter.status).toBe(401);

    // The freshly issued session keeps the acting user logged in.
    const meFresh = await fetchWithSession("/auth/me", {}, freshSession);
    expect(meFresh.status).toBe(200);
  });
});

// ─── Finding 5d: mfa.required auth gate (unit, via middleware extractAuth) ───

const mwUsersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});

function setupMiddlewareDb() {
  const { sqlite, internalSchema } = setupTestDb();
  sqlite.run(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user'
  )`);
  const db = drizzle({ client: sqlite });
  return { sqlite, db, internalSchema };
}

describe("middleware mfa.required gate", () => {
  test("blocks unenrolled users from normal routes but allows MFA enrollment + /me", async () => {
    const { sqlite, db, internalSchema } = setupMiddlewareDb();
    sqlite
      .query(
        "INSERT INTO users (id, email, password_hash, role) VALUES ('u1','noenroll@test.com','x','user')",
      )
      .run();

    const sessionId = await createSession(db as any, internalSchema, "u1", 3600, 1);
    const cookie = `bunbase_session=${sessionId}`;
    const config = { auth: { mfa: { required: true } } };

    const apiReq = new Request("http://localhost/api/posts", { headers: { cookie } });
    expect(
      await extractAuth(apiReq, db as any, internalSchema, mwUsersTable, undefined, config),
    ).toBeNull();

    const mfaReq = new Request("http://localhost/auth/mfa/totp/setup", { headers: { cookie } });
    expect(
      (await extractAuth(mfaReq, db as any, internalSchema, mwUsersTable, undefined, config))?.id,
    ).toBe("u1");

    const meReq = new Request("http://localhost/auth/me", { headers: { cookie } });
    expect(
      (await extractAuth(meReq, db as any, internalSchema, mwUsersTable, undefined, config))?.id,
    ).toBe("u1");

    sqlite.close();
  });

  test("allows enrolled users everywhere", async () => {
    const { sqlite, db, internalSchema } = setupMiddlewareDb();
    sqlite
      .query(
        "INSERT INTO users (id, email, password_hash, role) VALUES ('u2','e@test.com','x','user')",
      )
      .run();
    await (db as any).insert(internalSchema.mfaTotp).values({
      id: "t1",
      userId: "u2",
      encryptedSecret: "secret",
      verified: 1,
      createdAt: new Date().toISOString(),
    });

    const sessionId = await createSession(db as any, internalSchema, "u2", 3600, 1);
    const cookie = `bunbase_session=${sessionId}`;
    const config = { auth: { mfa: { required: true } } };

    const apiReq = new Request("http://localhost/api/posts", { headers: { cookie } });
    expect(
      (await extractAuth(apiReq, db as any, internalSchema, mwUsersTable, undefined, config))?.id,
    ).toBe("u2");

    sqlite.close();
  });

  test("without config (mfa not required) unenrolled users are not blocked", async () => {
    const { sqlite, db, internalSchema } = setupMiddlewareDb();
    sqlite
      .query(
        "INSERT INTO users (id, email, password_hash, role) VALUES ('u3','n@test.com','x','user')",
      )
      .run();

    const sessionId = await createSession(db as any, internalSchema, "u3", 3600, 1);
    const cookie = `bunbase_session=${sessionId}`;

    const apiReq = new Request("http://localhost/api/posts", { headers: { cookie } });
    expect((await extractAuth(apiReq, db as any, internalSchema, mwUsersTable))?.id).toBe("u3");

    sqlite.close();
  });
});

// ─── Finding 1: refresh token must not authenticate a request ───

describe("JWT bearer token type enforcement", () => {
  const secret = "test-jwt-secret-value";
  const prevJwt = (globalThis as any).__bunbaseJwtConfig;

  function withJwt() {
    (globalThis as any).__bunbaseJwtConfig = { enabled: true, secret };
  }
  function restore() {
    (globalThis as any).__bunbaseJwtConfig = prevJwt;
  }

  test("a refresh token is rejected as a bearer access token; an access token is accepted", async () => {
    withJwt();
    try {
      const { sqlite, db, internalSchema } = setupMiddlewareDb();
      sqlite
        .query(
          "INSERT INTO users (id, email, password_hash, role) VALUES ('ju','j@test.com','x','user')",
        )
        .run();

      const base = { sub: "ju", email: "j@test.com", role: "user" as const };
      const accessToken = await signJwt({ ...base, type: "access" }, secret, 900);
      const refreshToken = await signJwt({ ...base, type: "refresh" }, secret, 604800);

      const accessReq = new Request("http://localhost/api/posts", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const refreshReq = new Request("http://localhost/api/posts", {
        headers: { authorization: `Bearer ${refreshToken}` },
      });

      expect((await extractAuth(accessReq, db as any, internalSchema, mwUsersTable))?.id).toBe(
        "ju",
      );
      expect(await extractAuth(refreshReq, db as any, internalSchema, mwUsersTable)).toBeNull();

      sqlite.close();
    } finally {
      restore();
    }
  });
});
