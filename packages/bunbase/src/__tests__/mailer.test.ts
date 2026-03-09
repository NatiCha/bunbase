import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createEmailRoutes } from "../auth/email.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import type { EmailMessage } from "../mailer/index.ts";
import { createMailer, MailerError } from "../mailer/index.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

// ─── createMailer unit tests ─────────────────────────────────────────────────

describe("createMailer", () => {
  test("throws MailerError when 'from' is missing", () => {
    expect(() =>
      createMailer({
        from: "",
        transport: async () => {},
      }),
    ).toThrow(MailerError);
  });

  test("throws MailerError when 'transport' is not a function", () => {
    expect(() =>
      createMailer({
        from: "noreply@example.com",
        transport: null as any,
      }),
    ).toThrow(MailerError);
  });

  test("send() calls transport with correct fields", async () => {
    const sent: EmailMessage[] = [];
    const mailer = createMailer({
      from: "App <noreply@example.com>",
      transport: async (email) => {
        sent.push(email);
      },
    });

    await mailer.send({
      to: "user@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    });

    expect(sent.length).toBe(1);
    expect(sent[0]?.from).toBe("App <noreply@example.com>");
    expect(sent[0]?.to).toBe("user@example.com");
    expect(sent[0]?.subject).toBe("Hello");
    expect(sent[0]?.html).toBe("<p>Hi</p>");
  });

  test("send() allows overriding 'from'", async () => {
    const sent: EmailMessage[] = [];
    const mailer = createMailer({
      from: "Default <default@example.com>",
      transport: async (email) => {
        sent.push(email);
      },
    });

    await mailer.send({
      from: "Override <other@example.com>",
      to: "user@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(sent[0]?.from).toBe("Override <other@example.com>");
  });

  test("send() throws MailerError when transport throws", async () => {
    const mailer = createMailer({
      from: "noreply@example.com",
      transport: async () => {
        throw new Error("SMTP connection refused");
      },
    });

    await expect(
      mailer.send({ to: "user@example.com", subject: "Test", html: "<p>Test</p>" }),
    ).rejects.toThrow(MailerError);
  });

  test("sendPasswordReset() throws when appUrl is not configured", async () => {
    const mailer = createMailer({
      from: "noreply@example.com",
      transport: async () => {},
    });

    await expect(
      mailer.sendPasswordReset({ token: "tok", email: "user@example.com", userId: "u1" }),
    ).rejects.toThrow(MailerError);
  });

  test("sendPasswordReset() constructs reset URL and calls transport", async () => {
    const sent: EmailMessage[] = [];
    const mailer = createMailer({
      from: "noreply@example.com",
      appUrl: "https://myapp.com",
      transport: async (email) => {
        sent.push(email);
      },
    });

    await mailer.sendPasswordReset({ token: "abc123", email: "user@example.com", userId: "u1" });

    expect(sent.length).toBe(1);
    expect(sent[0]?.to).toBe("user@example.com");
    expect(sent[0]?.html).toContain("https://myapp.com/auth/reset-password?token=abc123");
    expect(sent[0]?.subject).toBeTruthy();
  });

  test("sendEmailVerification() throws when appUrl is not configured", async () => {
    const mailer = createMailer({
      from: "noreply@example.com",
      transport: async () => {},
    });

    await expect(
      mailer.sendEmailVerification({ token: "tok", email: "user@example.com", userId: "u1" }),
    ).rejects.toThrow(MailerError);
  });

  test("sendEmailVerification() constructs verify URL and calls transport", async () => {
    const sent: EmailMessage[] = [];
    const mailer = createMailer({
      from: "noreply@example.com",
      appUrl: "https://myapp.com",
      transport: async (email) => {
        sent.push(email);
      },
    });

    await mailer.sendEmailVerification({
      token: "xyz789",
      email: "user@example.com",
      userId: "u1",
    });

    expect(sent.length).toBe(1);
    expect(sent[0]?.to).toBe("user@example.com");
    expect(sent[0]?.html).toContain("https://myapp.com/auth/verify-email?token=xyz789");
  });

  test("sendPasswordReset() uses custom template when provided", async () => {
    const sent: EmailMessage[] = [];
    const mailer = createMailer({
      from: "noreply@example.com",
      appUrl: "https://myapp.com",
      transport: async (email) => {
        sent.push(email);
      },
      templates: {
        passwordReset: (ctx) => ({
          subject: "Custom reset subject",
          html: `<a href="${ctx.resetUrl}">custom link</a>`,
        }),
      },
    });

    await mailer.sendPasswordReset({ token: "tok", email: "user@example.com", userId: "u1" });

    expect(sent[0]?.subject).toBe("Custom reset subject");
    expect(sent[0]?.html).toContain("custom link");
  });

  test("appUrl trailing slash is stripped from URLs", async () => {
    const sent: EmailMessage[] = [];
    const mailer = createMailer({
      from: "noreply@example.com",
      appUrl: "https://myapp.com/",
      transport: async (email) => {
        sent.push(email);
      },
    });

    await mailer.sendPasswordReset({ token: "tok", email: "user@example.com", userId: "u1" });
    expect(sent[0]?.html).toContain("https://myapp.com/auth/reset-password?token=tok");
    expect(sent[0]?.html).not.toContain("//auth");
  });
});

// ─── Integration: password reset with mailer ─────────────────────────────────

const usersTable = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull(),
});

const _usersTableWithVerified = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull(),
  emailVerified: integer("email_verified").notNull().default(0),
});

function setupDb(withEmailVerified = false) {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  adapter.bootstrapInternalTables();
  const columns = withEmailVerified
    ? "id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0"
    : "id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL";
  sqlite.run(`CREATE TABLE users (${columns})`);
  sqlite
    .query("INSERT INTO users (id, email, password_hash, role) VALUES ($id, $email, $ph, $role)")
    .run({ $id: "user-1", $email: "test@example.com", $ph: "hash", $role: "user" });
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, internalSchema };
}

let _ip = 100;
function freshIp() {
  return `10.30.${++_ip}.1`;
}

test("password reset with mailer: sends email and returns 200", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const sent: EmailMessage[] = [];
  const mailer = createMailer({
    from: "noreply@example.com",
    appUrl: "https://app.example.com",
    transport: async (email) => {
      sent.push(email);
    },
  });

  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: false, cors: { origins: ["https://example.com"] } }),
    usersTable,
    mailer,
  });

  const response = await routes["/auth/request-password-reset"].POST(
    new Request("http://localhost/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ email: "test@example.com" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(sent.length).toBe(1);
  expect(sent[0]?.to).toBe("test@example.com");
  expect(sent[0]?.html).toContain("https://app.example.com/auth/reset-password?token=");

  sqlite.close();
});

test("password reset with mailer: mailer takes precedence over webhook", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const mailerSent: EmailMessage[] = [];
  const webhookCalls: string[] = [];

  const mailer = createMailer({
    from: "noreply@example.com",
    appUrl: "https://app.example.com",
    transport: async (email) => {
      mailerSent.push(email);
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    webhookCalls.push(String(url));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const routes = createEmailRoutes({
      db,
      internalSchema,
      config: makeResolvedConfig({
        development: false,
        cors: { origins: ["https://example.com"] },
        auth: { email: { webhook: "https://webhook.example.com/send" } },
      }),
      usersTable,
      mailer,
    });

    await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ email: "test@example.com" }),
      }),
    );

    expect(mailerSent.length).toBe(1);
    expect(webhookCalls.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("password reset with mailer: transport failure does not expose enumeration oracle", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  const mailer = createMailer({
    from: "noreply@example.com",
    appUrl: "https://app.example.com",
    transport: async () => {
      throw new Error("SMTP down");
    },
  });

  try {
    const routes = createEmailRoutes({
      db,
      internalSchema,
      config: makeResolvedConfig({
        development: false,
        cors: { origins: ["https://example.com"] },
      }),
      usersTable,
      mailer,
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ email: "test@example.com" }),
      }),
    );

    // Must still return 200 despite transport failure
    expect(response.status).toBe(200);
    expect(errors.length).toBeGreaterThan(0);
  } finally {
    console.error = origError;
    sqlite.close();
  }
});

// ─── Integration: /auth/request-email-verification ───────────────────────────

test("request-email-verification returns 503 when no mailer is configured", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
  });

  const response = await routes["/auth/request-email-verification"].POST(
    new Request("http://localhost/auth/request-email-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ email: "test@example.com" }),
    }),
  );

  expect(response.status).toBe(503);
  sqlite.close();
});

test("request-email-verification returns 200 (anti-enumeration) for unknown email", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const sent: EmailMessage[] = [];
  const mailer = createMailer({
    from: "noreply@example.com",
    appUrl: "https://app.example.com",
    transport: async (email) => {
      sent.push(email);
    },
  });

  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    mailer,
  });

  const response = await routes["/auth/request-email-verification"].POST(
    new Request("http://localhost/auth/request-email-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ email: "nobody@example.com" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(sent.length).toBe(0); // No email for unknown user
  sqlite.close();
});

test("request-email-verification sends email and creates token for known user", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const sent: EmailMessage[] = [];
  const mailer = createMailer({
    from: "noreply@example.com",
    appUrl: "https://app.example.com",
    transport: async (email) => {
      sent.push(email);
    },
  });

  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    mailer,
  });

  const response = await routes["/auth/request-email-verification"].POST(
    new Request("http://localhost/auth/request-email-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ email: "test@example.com" }),
    }),
  );

  expect(response.status).toBe(200);
  expect(sent.length).toBe(1);
  expect(sent[0]?.to).toBe("test@example.com");
  expect(sent[0]?.html).toContain("https://app.example.com/auth/verify-email?token=");

  // Verify token was created in DB
  const tokenRow = sqlite
    .query<{ type: string }, []>("SELECT type FROM _verification_tokens LIMIT 1")
    .get();
  expect(tokenRow?.type).toBe("email_verification");

  sqlite.close();
});

test("request-email-verification invalidates previous tokens", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const mailer = createMailer({
    from: "noreply@example.com",
    appUrl: "https://app.example.com",
    transport: async () => {},
  });

  const routes = createEmailRoutes({
    db,
    internalSchema,
    config: makeResolvedConfig({ development: true }),
    usersTable,
    mailer,
  });

  const ip = freshIp();
  // Send twice
  for (let i = 0; i < 2; i++) {
    await routes["/auth/request-email-verification"].POST(
      new Request("http://localhost/auth/request-email-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ email: "test@example.com" }),
      }),
    );
  }

  // Only one token should exist (second request invalidates the first)
  const count = sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) as n FROM _verification_tokens")
    .get();
  expect(count?.n).toBe(1);

  sqlite.close();
});

// ─── Backward compatibility: no mailer ───────────────────────────────────────

test("backward compat: no mailer uses webhook when configured", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const webhookCalls: string[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    webhookCalls.push(String(url));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const routes = createEmailRoutes({
      db,
      internalSchema,
      config: makeResolvedConfig({
        development: false,
        cors: { origins: ["https://example.com"] },
        auth: { email: { webhook: "https://webhook.example.com/send" } },
      }),
      usersTable,
      // No mailer
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ email: "test@example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(webhookCalls.length).toBe(1);
    expect(webhookCalls[0]).toBe("https://webhook.example.com/send");
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("backward compat: no mailer in dev logs token to console", async () => {
  const { sqlite, db, internalSchema } = setupDb();
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(" "));

  try {
    const routes = createEmailRoutes({
      db,
      internalSchema,
      config: makeResolvedConfig({ development: true }),
      usersTable,
      // No mailer
    });

    const response = await routes["/auth/request-password-reset"].POST(
      new Request("http://localhost/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ email: "test@example.com" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(logged.some((msg) => msg.includes("test@example.com"))).toBe(true);
  } finally {
    console.log = origLog;
    sqlite.close();
  }
});
