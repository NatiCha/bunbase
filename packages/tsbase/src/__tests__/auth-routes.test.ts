import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createAuthRoutes } from "../auth/routes.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  company: text("company").notNull(),
  nickname: text("nickname"),
});

function setupAuthRouteDb() {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      company TEXT NOT NULL,
      nickname TEXT
    )
  `);
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, internalSchema };
}

test("register accepts safe schema extras and sets cookies via separate headers", async () => {
  const { sqlite, db, internalSchema } = setupAuthRouteDb();
  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/register"].POST(
    new Request("http://localhost/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "password123",
        company: "TSBase LLC",
        nickname: "alice",
      }),
    }),
  );

  expect(response.status).toBe(201);
  const cookies = response.headers.getSetCookie();
  expect(cookies.length).toBe(2);
  expect(cookies.some((cookie) => cookie.startsWith("tsbase_session="))).toBe(true);
  expect(cookies.some((cookie) => cookie.startsWith("csrf_token="))).toBe(true);

  const inserted = sqlite
    .query<{ company: string; nickname: string | null }, { $email: string }>(
      "SELECT company, nickname FROM users WHERE email = $email",
    )
    .get({ $email: "alice@example.com" });
  expect(inserted?.company).toBe("TSBase LLC");
  expect(inserted?.nickname).toBe("alice");

  sqlite.close();
});

test("register rejects privileged fields and unknown fields", async () => {
  const { sqlite, db, internalSchema } = setupAuthRouteDb();
  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const privilegedResponse = await routes["/auth/register"].POST(
    new Request("http://localhost/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "bob@example.com",
        password: "password123",
        company: "Acme",
        role: "admin",
      }),
    }),
  );
  expect(privilegedResponse.status).toBe(400);

  const unknownResponse = await routes["/auth/register"].POST(
    new Request("http://localhost/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "carol@example.com",
        password: "password123",
        company: "Acme",
        unknownField: "nope",
      }),
    }),
  );
  expect(unknownResponse.status).toBe(400);

  sqlite.close();
});

test("login and logout emit separate cookie headers", async () => {
  const { sqlite, db, internalSchema } = setupAuthRouteDb();
  const routes = createAuthRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const passwordHash = await Bun.password.hash("password123");
  sqlite
    .query(
      `INSERT INTO users (id, email, password_hash, role, company, nickname)
       VALUES ($id, $email, $passwordHash, $role, $company, $nickname)`,
    )
    .run({
      $id: "user-1",
      $email: "login@example.com",
      $passwordHash: passwordHash,
      $role: "user",
      $company: "TSBase",
      $nickname: "login-user",
    });

  const loginResponse = await routes["/auth/login"].POST(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "login@example.com",
        password: "password123",
      }),
    }),
  );
  expect(loginResponse.status).toBe(200);
  const loginCookies = loginResponse.headers.getSetCookie();
  expect(loginCookies.length).toBe(2);

  const sessionCookie = loginCookies.find((cookie) =>
    cookie.startsWith("tsbase_session="),
  );
  const csrfCookie = loginCookies.find((cookie) =>
    cookie.startsWith("csrf_token="),
  );
  expect(sessionCookie).toBeDefined();
  expect(csrfCookie).toBeDefined();

  const sessionValue = sessionCookie?.split(";")[0] ?? "";
  const csrfValue = csrfCookie?.split(";")[0]?.split("=")[1] ?? "";
  const logoutResponse = await routes["/auth/logout"].POST(
    new Request("http://localhost/auth/logout", {
      method: "POST",
      headers: {
        "X-CSRF-Token": csrfValue,
        cookie: `${sessionValue}; csrf_token=${csrfValue}`,
      },
    }),
  );

  expect(logoutResponse.status).toBe(200);
  const logoutCookies = logoutResponse.headers.getSetCookie();
  expect(logoutCookies.length).toBe(2);

  sqlite.close();
});
