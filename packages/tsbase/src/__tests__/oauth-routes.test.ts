import { test, expect, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { bootstrapInternalTables } from "../core/bootstrap.ts";
import { createOAuthRoutes } from "../auth/oauth/routes.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

function setupDb(): Database {
  const sqlite = new Database(":memory:");
  bootstrapInternalTables(sqlite);
  sqlite.run(
    "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', name TEXT)",
  );
  return sqlite;
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

function callbackReq(state: string, stateCookie = state): Request {
  return new Request(
    `http://localhost/auth/oauth/google/callback?code=auth-code&state=${state}`,
    { headers: { cookie: `oauth_state=${stateCookie}` } },
  );
}

// ─── createOAuthRoutes ────────────────────────────────────────────────────────

test("createOAuthRoutes returns empty object when no oauth config", () => {
  const sqlite = setupDb();
  const config = makeResolvedConfig({ development: true });
  const routes = createOAuthRoutes({ sqlite, config });
  expect(Object.keys(routes)).toHaveLength(0);
  sqlite.close();
});

// ─── GET /auth/oauth/google (redirect) ────────────────────────────────────────

test("GET /auth/oauth/google redirects to Google with 302 and sets state cookie", () => {
  const sqlite = setupDb();
  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

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

// ─── GET /auth/oauth/google/callback ─────────────────────────────────────────

test("callback returns 400 when code is missing from query string", async () => {
  const sqlite = setupDb();
  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    new Request("http://localhost/auth/oauth/google/callback?state=abc"),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("callback returns 400 when state is missing from query string", async () => {
  const sqlite = setupDb();
  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    new Request("http://localhost/auth/oauth/google/callback?code=abc"),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("callback returns 400 when state does not match cookie", async () => {
  const sqlite = setupDb();
  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    new Request(
      "http://localhost/auth/oauth/google/callback?code=abc&state=wrong",
      { headers: { cookie: "oauth_state=correct" } },
    ),
  );
  expect(response.status).toBe(400);
  sqlite.close();
});

test("callback returns 500 when exchangeCode fetch throws", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockRejectedValueOnce(
    new Error("Network error"),
  );

  const sqlite = setupDb();
  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    callbackReq(STATE),
  );
  expect(response.status).toBe(500);
  sqlite.close();
});

test("callback creates new user and redirects on first OAuth login", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ access_token: "g-token" }) as any,
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "g-new-123",
        email: "newuser@gmail.com",
        name: "New User",
      }) as any,
    );

  const sqlite = setupDb();
  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    callbackReq(STATE),
  );

  expect(response.status).toBe(302);
  // Session cookie must be set
  const cookieHeader = response.headers.get("Set-Cookie") ?? "";
  expect(cookieHeader).toContain("tsbase_session=");

  // User was created in DB
  const user = sqlite
    .query<{ email: string }, []>("SELECT email FROM users")
    .get([]);
  expect(user?.email).toBe("newuser@gmail.com");

  // OAuth account was linked
  const account = sqlite
    .query<{ provider: string }, []>("SELECT provider FROM _oauth_accounts")
    .get([]);
  expect(account?.provider).toBe("google");

  sqlite.close();
});

test("callback links oauth account to existing user who shares the email", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ access_token: "g-token" }) as any,
    )
    .mockResolvedValueOnce(
      Response.json({ id: "g-999", email: "existing@example.com" }) as any,
    );

  const sqlite = setupDb();
  sqlite
    .query("INSERT INTO users (id, email, role) VALUES ($id, $email, $role)")
    .run({ $id: "existing-user", $email: "existing@example.com", $role: "user" });

  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    callbackReq(STATE),
  );

  expect(response.status).toBe(302);

  // OAuth account linked to the pre-existing user
  const account = sqlite
    .query<{ user_id: string }, []>("SELECT user_id FROM _oauth_accounts")
    .get([]);
  expect(account?.user_id).toBe("existing-user");

  // No new user created
  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM users")
    .get([]);
  expect(count?.n).toBe(1);

  sqlite.close();
});

test("callback reuses existing OAuth account without creating a new link", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({ access_token: "g-token" }) as any,
    )
    .mockResolvedValueOnce(
      Response.json({ id: "g-existing-provider-id", email: "oauth@example.com" }) as any,
    );

  const sqlite = setupDb();
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

  const routes = createOAuthRoutes({ sqlite, config: makeConfig() });

  const response = await (routes["/auth/oauth/google/callback"] as any).GET(
    callbackReq(STATE),
  );

  expect(response.status).toBe(302);

  // No new oauth accounts created
  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _oauth_accounts")
    .get([]);
  expect(count?.n).toBe(1);

  sqlite.close();
});
