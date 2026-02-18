import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { bootstrapInternalTables } from "../core/bootstrap.ts";
import { createEmailRoutes } from "../auth/email.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

function setupEmailDb(): Database {
  const sqlite = new Database(":memory:");
  bootstrapInternalTables(sqlite);
  sqlite.run(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL
    )
  `);
  sqlite
    .query(
      "INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $passwordHash, $role)",
    )
    .run({
      $id: "user-1",
      $email: "reset@example.com",
      $passwordHash: "hash",
      $role: "user",
    });
  return sqlite;
}

test("password reset posts webhook payload when configured", async () => {
  const sqlite = setupEmailDb();
  const calls: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init?.body ?? ""),
    });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const routes = createEmailRoutes({
      sqlite,
      config: makeResolvedConfig({
        auth: {
          tokenExpiry: 3600,
          email: { webhook: "https://example.com/send-email" },
        },
      }),
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.1",
        },
        body: JSON.stringify({ email: "reset@example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://example.com/send-email");
    expect(calls[0]?.body.includes("\"type\":\"password_reset\"")).toBe(true);
    expect(calls[0]?.body.includes("\"email\":\"reset@example.com\"")).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("password reset returns server error when webhook fails", async () => {
  const sqlite = setupEmailDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("bad", { status: 500 })) as unknown as typeof fetch;

  try {
    const routes = createEmailRoutes({
      sqlite,
      config: makeResolvedConfig({
        auth: {
          tokenExpiry: 3600,
          email: { webhook: "https://example.com/send-email" },
        },
      }),
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.2",
        },
        body: JSON.stringify({ email: "reset@example.com" }),
      }),
    );

    expect(response.status).toBe(500);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
