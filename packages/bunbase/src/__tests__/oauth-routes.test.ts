import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createOAuthRoutes } from "../auth/oauth/routes.ts";
import { createSession } from "../auth/sessions.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  name: text("name"),
});

function setupDb() {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', name TEXT)",
  );
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, internalSchema };
}

function makeConfig() {
  return makeResolvedConfig({
    development: true,
    auth: {
      oauth: {
        redirectUrl: "http://localhost:3000",
        google: {
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
        },
      },
    } as any,
  });
}

const STATE = "test-state-value-123";

/** Build a callback request with the state cookie encoded as JSON (new format). */
function callbackReq(nonce: string, action: "login" | "link" = "login", userId?: string): Request {
  const stateObj: Record<string, string> = { nonce, action };
  if (userId) stateObj.userId = userId;
  const cookieValue = encodeURIComponent(JSON.stringify(stateObj));
  return new Request(`http://localhost/auth/oauth/google/callback?code=auth-code&state=${nonce}`, {
    headers: { cookie: `oauth_state=${cookieValue}` },
  });
}

/** Build a callback request with legacy plain-UUID state cookie (backward compat). */
function callbackReqLegacy(state: string): Request {
  return new Request(`http://localhost/auth/oauth/google/callback?code=auth-code&state=${state}`, {
    headers: { cookie: `oauth_state=${state}` },
  });
}

// ─── createOAuthRoutes ────────────────────────────────────────────────────────

test("createOAuthRoutes returns empty object when no oauth config", () => {
  const { sqlite, db, internalSchema } = setupDb();
  const config = makeResolvedConfig({ development: true });
  const routes = createOAuthRoutes({ db, internalSchema, config, usersTable });
  expect(Object.keys(routes)).toHaveLength(0);
  sqlite.close();
});

// ─── GET /auth/oauth/google (redirect) ────────────────────────────────────────

test("GET /auth/oauth/google redirects to Google with 302 and sets state cookie", () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = (routes["/auth/oauth/google"] as any).GET(
    new Request("http://localhost/auth/oauth/google"),
  );

  expect(response.status).toBe(302);
  const location = response.headers.get("Location") ?? "";
  expect(location).toContain("accounts.google.com");
  expect(location).toContain("google-client-id");

  const cookie = response.headers.get("Set-Cookie") ?? "";
  expect(cookie).toContain("oauth_state=");
  expect(cookie).toContain("HttpOnly");
  sqlite.close();
});

// ─── POST /auth/oauth/google/link ─────────────────────────────────────────────

test("POST /auth/oauth/google/link returns 403 when CSRF token missing", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/link"] as any).POST(
    new Request("http://localhost/auth/oauth/google/link", { method: "POST" }),
  );
  expect(response.status).toBe(403);
  sqlite.close();
});

test("POST /auth/oauth/google/link returns 401 when not authenticated", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  // Valid CSRF (cookie + header match) but no session
  const csrfToken = "test-csrf-token";
  const response = await (routes["/auth/oauth/google/link"] as any).POST(
    new Request("http://localhost/auth/oauth/google/link", {
      method: "POST",
      headers: {
        cookie: `csrf_token=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    }),
  );
  expect(response.status).toBe(401);
  sqlite.close();
});

test("POST /auth/oauth/google/link redirects to Google with link state for authenticated user", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  sqlite.run(
    "INSERT INTO users (id, email, role) VALUES ('link-user', 'link@example.com', 'user')",
  );
  const sessionId = await createSession(db, internalSchema, "link-user");

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });
  const csrfToken = "test-csrf-token";

  const response = await (routes["/auth/oauth/google/link"] as any).POST(
    new Request("http://localhost/auth/oauth/google/link", {
      method: "POST",
      headers: {
        cookie: `bunbase_session=${sessionId}; csrf_token=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
    }),
  );

  expect(response.status).toBe(302);
  const location = response.headers.get("Location") ?? "";
  expect(location).toContain("accounts.google.com");

  // State cookie should contain action: "link" and the user's ID
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  expect(setCookie).toContain("oauth_state=");
  const cookieValue = decodeURIComponent(setCookie.split("oauth_state=")[1]?.split(";")[0] ?? "");
  const stateObj = JSON.parse(cookieValue);
  expect(stateObj.action).toBe("link");
  expect(stateObj.userId).toBe("link-user");

  sqlite.close();
});

// ─── GET /auth/oauth/google/callback ─────────────────────────────────────────

test("callback returns 400 when code is missing from query string", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    new Request("http://localhost/auth/oauth/google/callback?state=abc"),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("callback returns 400 when state is missing from query string", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    new Request("http://localhost/auth/oauth/google/callback?code=abc"),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("callback returns 400 when state does not match cookie", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const cookieValue = encodeURIComponent(JSON.stringify({ nonce: "correct", action: "login" }));
  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    new Request("http://localhost/auth/oauth/google/callback?code=abc&state=wrong", {
      headers: { cookie: `oauth_state=${cookieValue}` },
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("callback returns 400 when state does not match legacy plain-UUID cookie", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    new Request("http://localhost/auth/oauth/google/callback?code=abc&state=wrong", {
      headers: { cookie: "oauth_state=correct" },
    }),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("callback returns 500 when exchangeCode fetch throws", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));
  expect(response.status).toBe(500);
  sqlite.close();
});

test("callback creates new user and redirects on first OAuth login", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({
        id: "g-new-123",
        email: "newuser@gmail.com",
        name: "New User",
        verified_email: true,
      }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));

  expect(response.status).toBe(302);
  // Session cookie must be set
  const cookieHeader = response.headers.get("Set-Cookie") ?? "";
  expect(cookieHeader).toContain("bunbase_session=");

  // User was created in DB
  const user = sqlite.query<{ email: string }, []>("SELECT email FROM users").get();
  expect(user?.email).toBe("newuser@gmail.com");

  // OAuth account was linked
  const account = sqlite
    .query<{ provider: string }, []>("SELECT provider FROM _oauth_accounts")
    .get();
  expect(account?.provider).toBe("google");

  sqlite.close();
});

test("callback auto-links OAuth account to existing user when provider confirms email is verified", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-999", email: "existing@example.com", verified_email: true }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "existing-user", $email: "existing@example.com", $role: "user" });

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));

  expect(response.status).toBe(302);

  // OAuth account linked to the pre-existing user
  const account = sqlite
    .query<{ user_id: string }, []>("SELECT user_id FROM _oauth_accounts")
    .get();
  expect(account?.user_id).toBe("existing-user");

  // No new user created
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM users").get();
  expect(count?.n).toBe(1);

  sqlite.close();
});

test("callback redirects with ACCOUNT_LINK_REQUIRED when email collision and provider does not confirm verification", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      // No verified_email field — conservative: block auto-link
      Response.json({ id: "g-unverified", email: "victim@example.com" }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "victim-user", $email: "victim@example.com", $role: "user" });

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));

  // Must redirect to error URL, not create a session
  expect(response.status).toBe(302);
  const location = response.headers.get("Location") ?? "";
  expect(location).toContain("error=ACCOUNT_LINK_REQUIRED");
  expect(response.headers.get("Set-Cookie") ?? "").not.toContain("bunbase_session=");

  // No new OAuth account row created
  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _oauth_accounts")
    .get();
  expect(count?.n).toBe(0);

  sqlite.close();
});

test("callback redirects with ACCOUNT_LINK_REQUIRED when email collision and provider explicitly says unverified", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({
        id: "g-false-verified",
        email: "victim2@example.com",
        verified_email: false,
      }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "victim-user-2", $email: "victim2@example.com", $role: "user" });

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));

  expect(response.status).toBe(302);
  const location = response.headers.get("Location") ?? "";
  expect(location).toContain("error=ACCOUNT_LINK_REQUIRED");

  sqlite.close();
});

test("callback reuses existing OAuth account without creating a new link", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-existing-provider-id", email: "oauth@example.com" }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "oauth-user", $email: "oauth@example.com", $role: "user" });
  sqlite
    .query(
      "INSERT INTO _oauth_accounts (id, user_id, provider, provider_account_id, created_at) VALUES ($id, $userId, $provider, $accountId, $createdAt)",
    )
    .run({
      $id: "oa-1",
      $userId: "oauth-user",
      $provider: "google",
      $accountId: "g-existing-provider-id",
      $createdAt: new Date().toISOString(),
    });

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));

  expect(response.status).toBe(302);

  // No new oauth accounts created
  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _oauth_accounts")
    .get();
  expect(count?.n).toBe(1);

  sqlite.close();
});

// ─── Link callback flow ───────────────────────────────────────────────────────

test("link callback inserts oauth account for authenticated user and redirects with linked=true", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-new-link-id", email: "other@example.com" }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  sqlite.run(
    "INSERT INTO users (id, email, role) VALUES ('linker-user', 'linker@example.com', 'user')",
  );
  const sessionId = await createSession(db, internalSchema, "linker-user");

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const req = new Request(
    `http://localhost/auth/oauth/google/callback?code=auth-code&state=${STATE}`,
    {
      headers: {
        cookie: `bunbase_session=${sessionId}; oauth_state=${encodeURIComponent(JSON.stringify({ nonce: STATE, action: "link", userId: "linker-user" }))}`,
      },
    },
  );

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(req);

  expect(response.status).toBe(302);
  const location = response.headers.get("Location") ?? "";
  expect(location).toContain("linked=true");
  expect(location).not.toContain("error=");

  // OAuth account was linked to linker-user
  const account = sqlite
    .query<{ user_id: string; provider_account_id: string }, []>(
      "SELECT user_id, provider_account_id FROM _oauth_accounts",
    )
    .get();
  expect(account?.user_id).toBe("linker-user");
  expect(account?.provider_account_id).toBe("g-new-link-id");

  // No new user created
  const count = sqlite.query<{ n: number }, []>("SELECT COUNT(*) as n FROM users").get();
  expect(count?.n).toBe(1);

  sqlite.close();
});

test("link callback returns 401 when session is absent", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-link-no-auth", email: "other@example.com" }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const req = new Request(
    `http://localhost/auth/oauth/google/callback?code=auth-code&state=${STATE}`,
    {
      headers: {
        cookie: `oauth_state=${encodeURIComponent(JSON.stringify({ nonce: STATE, action: "link", userId: "some-user" }))}`,
      },
    },
  );

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(req);
  expect(response.status).toBe(401);
  sqlite.close();
});

test("link callback returns 403 when session user id does not match state user id", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-mismatch-id", email: "other@example.com" }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  sqlite.run(
    "INSERT INTO users (id, email, role) VALUES ('real-user', 'real@example.com', 'user')",
  );
  const sessionId = await createSession(db, internalSchema, "real-user");

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  // State claims to be for "attacker-user" but the session belongs to "real-user"
  const req = new Request(
    `http://localhost/auth/oauth/google/callback?code=auth-code&state=${STATE}`,
    {
      headers: {
        cookie: `bunbase_session=${sessionId}; oauth_state=${encodeURIComponent(JSON.stringify({ nonce: STATE, action: "link", userId: "attacker-user" }))}`,
      },
    },
  );

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(req);
  expect(response.status).toBe(403);
  sqlite.close();
});

test("link callback returns 409 when provider account already linked to another user", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-already-linked", email: "other@example.com" }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  sqlite.run(
    "INSERT INTO users (id, email, role) VALUES ('linker-user', 'linker@example.com', 'user')",
  );
  sqlite.run(
    "INSERT INTO users (id, email, role) VALUES ('other-user', 'other@example.com', 'user')",
  );
  // "g-already-linked" is already linked to other-user
  sqlite.run(
    `INSERT INTO _oauth_accounts (id, user_id, provider, provider_account_id, created_at)
     VALUES ('oa-existing', 'other-user', 'google', 'g-already-linked', '${new Date().toISOString()}')`,
  );
  const sessionId = await createSession(db, internalSchema, "linker-user");

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  const req = new Request(
    `http://localhost/auth/oauth/google/callback?code=auth-code&state=${STATE}`,
    {
      headers: {
        cookie: `bunbase_session=${sessionId}; oauth_state=${encodeURIComponent(JSON.stringify({ nonce: STATE, action: "link", userId: "linker-user" }))}`,
      },
    },
  );

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(req);
  expect(response.status).toBe(409);
  sqlite.close();
});

// ─── Legacy plain-UUID state backward compat ─────────────────────────────────

test("callback handles legacy plain-UUID state cookie (backward compat)", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-legacy-123", email: "legacy@gmail.com", verified_email: true }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();
  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });

  // Legacy: state cookie is a plain UUID string, not JSON
  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    callbackReqLegacy(STATE),
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("Set-Cookie") ?? "").toContain("bunbase_session=");
  sqlite.close();
});

// ─── Race-condition: account-link unique constraint recovery ──────────────────

test("callback recovers from race: creates session for winning userId on unique constraint", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(
      Response.json({ id: "g-race-id", email: "race@example.com", verified_email: true }) as any,
    );

  const { sqlite, db, internalSchema } = setupDb();

  // Pre-seed the user (the "winning" concurrent request already created them)
  sqlite.run(
    "INSERT INTO users (id, email, role) VALUES ('winner-user', 'race@example.com', 'user')",
  );

  // Spy on db.insert: when the first insert into _oauth_accounts is attempted,
  // simulate the race — seed the winning row directly then throw the constraint error
  let oauthInsertIntercepted = false;
  const originalInsert = (db as any).insert.bind(db);
  spyOn(db as any, "insert").mockImplementation((table: any) => {
    if (table === internalSchema.oauthAccounts && !oauthInsertIntercepted) {
      oauthInsertIntercepted = true;
      return {
        values: () => {
          // The "winning" request inserts this row first
          sqlite.run(
            "INSERT INTO _oauth_accounts (id, user_id, provider, provider_account_id, created_at) VALUES ('oa-winner', 'winner-user', 'google', 'g-race-id', '2024-01-01')",
          );
          // Our insert loses the race and hits the unique constraint
          return Promise.reject(
            new Error(
              "UNIQUE constraint failed: _oauth_accounts.provider, _oauth_accounts.provider_account_id",
            ),
          );
        },
      };
    }
    return originalInsert(table);
  });

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });
  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));

  // Recovered: session created, no 500
  expect(response.status).toBe(302);
  expect(response.headers.get("Set-Cookie") ?? "").toContain("bunbase_session=");

  // Exactly one link row — the winning one, no duplicate
  const linkCount = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _oauth_accounts")
    .get();
  expect(linkCount?.n).toBe(1);

  sqlite.close();
});

test("callback returns 500 when account-link insert fails with a non-constraint error", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "g-token" }) as any)
    .mockResolvedValueOnce(Response.json({ id: "g-err-id", email: "error@example.com" }) as any);

  const { sqlite, db, internalSchema } = setupDb();

  const originalInsert = (db as any).insert.bind(db);
  spyOn(db as any, "insert").mockImplementation((table: any) => {
    if (table === internalSchema.oauthAccounts) {
      return {
        values: () => Promise.reject(new Error("Disk full — non-constraint storage error")),
      };
    }
    return originalInsert(table);
  });

  const routes = createOAuthRoutes({ db, internalSchema, config: makeConfig(), usersTable });
  const response = await (routes["/auth/oauth/google/callback"] as any).GET(callbackReq(STATE));

  expect(response.status).toBe(500);
  sqlite.close();
});
