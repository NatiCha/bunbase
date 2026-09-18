import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { encrypt } from "../auth/encryption.ts";
import { revokeUserJwts, signJwt, verifyJwt } from "../auth/jwt/core.ts";
import { generateSecret, generateTotpCode } from "../auth/mfa/totp-core.ts";
import { resetRateLimit } from "../auth/rate-limit.ts";
import { hashToken } from "../auth/tokens.ts";
import { getTemplate } from "../cli/templates.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { createDevMailServer } from "../mailer/dev-server.ts";
import { createSmtpTransport } from "../mailer/transports/smtp.ts";
import { isChanged } from "../rules/helpers.ts";
import { createTestServer, type TestServer } from "../testing/index.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});
const records = sqliteTable("records", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  secret: text("secret"),
});
const internal = getInternalSchema("sqlite");
const servers: TestServer[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const server of servers.splice(0)) server.cleanup();
  resetRateLimit();
});
async function setup(
  config: Parameters<typeof createTestServer>[0]["config"] = {},
  rules?: any,
  hooks?: any,
) {
  const server = await createTestServer({
    schema: { users, records },
    config: {
      ...config,
      auth: { rateLimit: { max: 10000 }, ...config?.auth },
    },
    rules: rules ?? {
      records: { list: ({ auth }: any) => !!auth, get: ({ auth }: any) => !!auth },
    },
    hooks,
  });
  servers.push(server);
  return server;
}
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const jwtSecret = "security-regression-jwt-secret";
async function tokens(userId: string, secret = jwtSecret) {
  const base = { sub: userId, email: `${userId}@example.com`, role: "admin" };
  return {
    access: await signJwt({ ...base, type: "access" }, secret, 900),
    refresh: await signJwt({ ...base, type: "refresh" }, secret, 604800),
  };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
async function resetToken(server: TestServer, userId: string) {
  const token = crypto.randomUUID();
  await (server.db as any).insert(internal.verificationTokens).values({
    id: token,
    userId,
    tokenHash: await hashToken(token),
    type: "password_reset",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: new Date().toISOString(),
  });
  return token;
}

test("admin assets reject path and URL injection while a built asset still loads", async () => {
  const server = await setup();
  const dir = mkdtempSync(join(tmpdir(), "bunbase-file-boundary-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "outside.txt");
  writeFileSync(target, "outside-file-sentinel");
  for (const suffix of [
    target,
    `file:${target}`,
    `file://${target}`,
    encodeURIComponent(target),
    "..%2foutside.txt",
    "%2e%2e%5coutside.txt",
    "%ZZ",
    "//example.test/x.js",
  ]) {
    const response = await server.fetch(`/_admin-assets/${suffix}`);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("outside-file-sentinel");
  }
  const asset = readdirSync(join(import.meta.dir, "../../dist/admin")).find((name) =>
    name.endsWith(".js"),
  )!;
  expect((await server.fetch(`/_admin-assets/${asset}`)).status).toBe(200);
});

test("duplicate-ID create never returns private data or fires afterCreate", async () => {
  let created = 0;
  const server = await setup(
    {},
    { records: { create: () => true, list: () => false, get: () => false } },
    {
      records: {
        afterCreate: () => {
          created++;
        },
      },
    },
  );
  await (server.db as any)
    .insert(records)
    .values({ id: "victim", ownerId: "victim", secret: "private-sentinel" });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await server.fetch(
      "/api/records",
      post({ id: "victim", ownerId: "attacker" }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-sentinel");
    expect(created).toBe(0);
  } finally {
    error.mockRestore();
  }
  expect((await server.fetch("/api/records", post({ id: "new", ownerId: "caller" }))).status).toBe(
    201,
  );
  expect(created).toBe(1);
});

test("create and update rules authorize canonical aliases and reject ambiguous bodies", async () => {
  const server = await setup(
    {},
    {
      records: {
        create: ({ body }: any) => body.ownerId === "owner",
        update: ({ body, record }: any) => !isChanged(body, record, "ownerId"),
      },
    },
  );
  expect((await server.fetch("/api/records", post({ id: "r", owner_id: "owner" }))).status).toBe(
    201,
  );
  expect(
    (await server.fetch("/api/records", post({ id: "other", owner_id: "attacker" }))).status,
  ).toBe(403);
  for (const body of [{ ownerId: "attacker" }, { owner_id: "attacker" }]) {
    expect((await server.fetch("/api/records/r", { ...post(body), method: "PATCH" })).status).toBe(
      403,
    );
  }
  expect(
    (
      await server.fetch("/api/records/r", {
        ...post({ ownerId: "owner", owner_id: "attacker" }),
        method: "PATCH",
      })
    ).status,
  ).toBe(400);
  expect(
    (await server.fetch("/api/records/r", { ...post({ secret: "changed" }), method: "PATCH" }))
      .status,
  ).toBe(200);
  expect((await (server.db as any).select().from(records))[0]?.ownerId).toBe("owner");
});

test("password reset of enrolled account requires TOTP before protected access", async () => {
  const key = "test-encryption-key";
  const server = await setup({ auth: { mfa: { totp: { enabled: true }, encryptionKey: key } } });
  const user = await server.loginAs("mfa@example.com");
  const secret = generateSecret();
  await (server.db as any).insert(internal.mfaTotp).values({
    id: "totp",
    userId: user.userId,
    encryptedSecret: await encrypt(secret.base32, key),
    verified: 1,
    createdAt: new Date().toISOString(),
  });
  const response = await server.fetch(
    "/auth/reset-password",
    post({ token: await resetToken(server, user.userId), password: "replacement-password123" }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).mfaRequired).toBe(true);
  const cookie = response.headers
    .getAll("set-cookie")
    .map((v) => v.split(";")[0])
    .join("; ");
  const request = (path: string, init: RequestInit = {}) =>
    fetch(server.baseUrl + path, { ...init, headers: { cookie, ...init.headers } });
  expect((await request("/api/records")).status).toBe(403);
  expect(
    (await request("/auth/mfa/totp/verify", post({ code: generateTotpCode(secret.base32) })))
      .status,
  ).toBe(200);
  expect((await request("/api/records")).status).toBe(200);
  expect((await user.fetch("/auth/me")).status).toBe(401);
});

test("passkey mutations require CSRF while public login options remain reachable", async () => {
  const server = await setup({ auth: { mfa: { passkeys: { enabled: true } } } });
  const user = await server.loginAs("passkey@example.com");
  await (server.db as any).insert(internal.passkeyCredentials).values({
    id: "credential",
    name: "Test",
    userId: user.userId,
    publicKey: "key",
    counter: 0,
    deviceType: "singleDevice",
    backedUp: 0,
    createdAt: new Date().toISOString(),
  });
  const response = await fetch(`${server.baseUrl}/auth/passkeys/delete`, {
    ...post({ id: "credential" }),
    headers: {
      cookie: `bunbase_session=${user.sessionId}`,
      "content-type": "text/plain",
      origin: "http://evil.localhost",
    },
  });
  expect(response.status).toBe(403);
  expect((await user.fetch("/auth/passkeys/delete", post({ id: "credential" }))).status).toBe(200);
  expect(
    (await server.fetch("/auth/passkeys/login/options", post({ email: "passkey@example.com" })))
      .status,
  ).toBe(200);
});

test("JWT verification is server-local including a disabled server and uses current role", async () => {
  const one = await setup({ auth: { jwt: { enabled: true, secret: jwtSecret } } });
  const disabled = await setup();
  const two = await setup({ auth: { jwt: { enabled: true, secret: "other-secret" } } });
  for (const server of [one, two, disabled])
    await server.loginAs({ id: "u", email: "u@example.com", role: "user" });
  const token = (await tokens("u")).access;
  expect((await one.fetch("/auth/me", { headers: bearer(token) })).status).toBe(200);
  expect((await two.fetch("/auth/me", { headers: bearer(token) })).status).toBe(401);
  expect((await disabled.fetch("/auth/me", { headers: bearer(token) })).status).toBe(401);
  expect((await (await one.fetch("/auth/me", { headers: bearer(token) })).json()).user.role).toBe(
    "user",
  );
  const refreshed = await one.fetch(
    "/auth/refresh",
    post({ refreshToken: (await tokens("u")).refresh }),
  );
  expect((await verifyJwt((await refreshed.json()).accessToken, jwtSecret))?.role).toBe("user");
});

for (const operation of ["logout", "reset", "change", "delete"] as const) {
  test(`JWT access and refresh are revoked after ${operation}; other users and fresh tokens work`, async () => {
    const server = await setup({ auth: { jwt: { enabled: true, secret: jwtSecret } } });
    const reg = await server.fetch(
      "/auth/register",
      post({ email: "life@example.com", password: "original-password123" }),
    );
    const id = (await reg.json()).user.id;
    const old = await tokens(id);
    const other = await server.loginAs({ id: "other", email: "other@example.com" });
    const untouched = await tokens(other.userId);
    let response: Response;
    if (operation === "reset")
      response = await server.fetch(
        "/auth/reset-password",
        post({ token: await resetToken(server, id), password: "new-password123" }),
      );
    else if (operation === "logout")
      response = await server.fetch("/auth/logout", { ...post({}), headers: bearer(old.access) });
    else if (operation === "change")
      response = await server.fetch("/auth/change-password", {
        ...post({ currentPassword: "original-password123", newPassword: "new-password123" }),
        headers: bearer(old.access),
      });
    else
      response = await server.fetch("/auth/delete-account", {
        ...post({ password: "original-password123" }),
        headers: bearer(old.access),
      });
    expect(response.status).toBe(200);
    expect((await server.fetch("/auth/me", { headers: bearer(old.access) })).status).toBe(401);
    expect((await server.fetch("/auth/refresh", post({ refreshToken: old.refresh }))).status).toBe(
      401,
    );
    expect((await server.fetch("/auth/me", { headers: bearer(untouched.access) })).status).toBe(
      200,
    );
    if (operation !== "delete")
      expect(
        (await server.fetch("/auth/me", { headers: bearer((await tokens(id)).access) })).status,
      ).toBe(200);
  });
}

test("concurrent user revocations never resurrect a JWT", async () => {
  const server = await setup();
  const old = await tokens("u");
  await Promise.all(Array.from({ length: 10 }, () => revokeUserJwts(server.db, internal, "u")));
  expect(await verifyJwt(old.access, jwtSecret, server.db, internal)).toBeNull();
  expect(
    await verifyJwt((await tokens("u")).access, jwtSecret, server.db, internal),
  ).not.toBeNull();
});

test("startup logs omit supplied and generated service keys while keys still authenticate", async () => {
  const logs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  try {
    const key = "bb_sk_test-do-not-log";
    const server = await setup({ serviceKey: key });
    expect((await server.fetch("/api/records", { headers: bearer(key) })).status).toBe(200);
    await setup();
    expect(logs.join("\n")).not.toContain(key);
    expect(logs.join("\n")).not.toMatch(/bb_sk_[a-zA-Z0-9]/);
  } finally {
    log.mockRestore();
  }
});

test("SMTP rejects CR/LF injection before connection, accepts display names and multiline bodies", async () => {
  const mail = createDevMailServer({ smtpPort: 0, httpPort: 0 });
  cleanups.push(() => mail.stop());
  const transport = createSmtpTransport({ host: "localhost", port: (mail.smtp as any).port });
  const message = {
    from: "Sender <sender@example.com>",
    to: "recipient@example.com",
    subject: "Hello",
    html: "<p>Hi\nthere</p>",
    text: "Hi\nthere",
  };
  for (const field of ["from", "to", "subject", "replyTo"] as const) {
    for (const separator of ["\r", "\n", "\r\n"]) {
      await expect(
        transport({
          ...message,
          [field]: `sender@example.com${separator}Bcc: attacker@example.com`,
        }),
      ).rejects.toThrow("Invalid SMTP");
    }
  }
  expect(mail.emails).toHaveLength(0);
  await transport(message);
  expect(mail.emails).toHaveLength(1);
  expect(mail.emails[0]?.to).toBe("recipient@example.com");
  expect(mail.emails[0]?.text).toBe(message.text);
});

test("generated SaaS rules scope list and direct reads to persisted membership", async () => {
  const cache = join(import.meta.dir, "../../.cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "tenant-security-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const template = getTemplate("saas", "sqlite", [], "test");
  writeFileSync(join(dir, "schema.ts"), template.schema);
  writeFileSync(join(dir, "rules.ts"), template.rules);
  const schema = await import(join(dir, "schema.ts"));
  const { rules } = await import(join(dir, "rules.ts"));
  const server = await createTestServer({ schema, rules });
  servers.push(server);
  for (const id of ["alice", "bob"])
    await (server.db as any)
      .insert(schema.users)
      .values({ id, email: `${id}@example.com`, passwordHash: "x", role: "user" });
  const alice = await server.loginAs({ id: "alice", email: "alice@example.com" });
  const bob = await server.loginAs({ id: "bob", email: "bob@example.com" });
  for (const id of ["alice", "bob"]) {
    await (server.db as any)
      .insert(schema.organizations)
      .values({ id, name: id, slug: id, ownerId: "tenant-owner" });
    await (server.db as any).insert(schema.members).values({ id, organizationId: id, userId: id });
    await (server.db as any)
      .insert(schema.invoices)
      .values({ id, organizationId: id, amount: "100" });
  }
  for (const table of ["organizations", "members", "invoices"]) {
    const response = await alice.fetch(`/api/${table}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.map((row: any) => row.id)).toEqual(["alice"]);
    expect((await alice.fetch(`/api/${table}/bob`)).status).not.toBe(200);
    expect((await bob.fetch(`/api/${table}/bob`)).status).toBe(200);
  }
  await (server.db as any).delete(schema.members).where(eq(schema.members.userId, "alice"));
  expect((await (await alice.fetch("/api/invoices")).json()).data).toEqual([]);
  expect(
    (
      await alice.fetch(
        "/api/organizations",
        post({ id: "owned", name: "Owned", slug: "owned", owner_id: "alice" }),
      )
    ).status,
  ).toBe(201);
  expect((await alice.fetch("/api/organizations/owned")).status).toBe(200);
  expect((await bob.fetch("/api/organizations/owned")).status).not.toBe(200);
  expect(
    (
      await alice.fetch(
        "/api/organizations",
        post({ id: "forged", name: "Forged", slug: "forged", ownerId: "bob" }),
      )
    ).status,
  ).toBe(403);
});

async function socket(server: TestServer, cookie = "", origin?: string) {
  const ws = new WebSocket(`${server.baseUrl.replace(/^http/, "ws")}/realtime`, {
    headers: { cookie, ...(origin === undefined ? {} : { origin }) },
  } as any);
  cleanups.push(() => ws.close());
  const messages: any[] = [];
  ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket upgrade failed"));
  });
  return { ws, messages, send: (value: unknown) => ws.send(JSON.stringify(value)) };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

test("realtime rejects foreign/null origins and permits same-origin, configured and native clients", async () => {
  const server = await setup({
    realtime: { enabled: true, authorize: () => true },
    cors: { origins: ["https://trusted.example"] },
  });
  for (const origin of ["https://evil.example", "null"]) {
    expect((await fetch(`${server.baseUrl}/realtime`, { headers: { origin } })).status).toBe(403);
  }
  for (const origin of [server.baseUrl, "https://trusted.example", undefined]) {
    const connection = await socket(server, "", origin);
    expect(connection.ws.readyState).toBe(WebSocket.OPEN);
    connection.ws.close();
  }
});

for (const mutation of ["revoke", "expire", "delete", "demote"] as const) {
  test(`realtime table delivery rechecks ${mutation} and existing sockets cannot resubscribe`, async () => {
    const server = await setup(
      { realtime: { enabled: true, authorize: () => true } },
      { records: { list: ({ auth }: any) => auth?.role === "admin", create: () => true } },
    );
    const user = await server.loginAs({ id: "realtime-user", role: "admin" });
    const conn = await socket(server, `bunbase_session=${user.sessionId}`);
    conn.send({ type: "subscribe:table", table: "records" });
    // No subscribe acknowledgement in this protocol; wait for the existing async subscription.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await server.fetch("/api/records", post({ id: "before", ownerId: "owner", secret: "before" }));
    await until(() => conn.messages.some((message) => message.id === "before"));
    conn.messages.length = 0;
    if (mutation === "revoke")
      await (server.db as any)
        .delete(internal.sessions)
        .where(eq(internal.sessions.id, user.sessionId));
    if (mutation === "expire")
      await (server.db as any)
        .update(internal.sessions)
        .set({ expiresAt: 0 })
        .where(eq(internal.sessions.id, user.sessionId));
    if (mutation === "delete")
      await (server.db as any).delete(users).where(eq(users.id, user.userId));
    if (mutation === "demote")
      await (server.db as any).update(users).set({ role: "user" }).where(eq(users.id, user.userId));
    await server.fetch("/api/records", post({ id: "after", ownerId: "owner", secret: "after" }));
    if (mutation === "demote") {
      conn.send({ type: "subscribe:table", table: "records" });
      await until(() => conn.messages.some((message) => message.type === "error"));
    } else await until(() => conn.ws.readyState === WebSocket.CLOSED);
    expect(conn.messages.some((message) => message.type === "table:change")).toBe(false);
  });
}

for (const mode of ["broadcast", "presence"] as const) {
  test(`revoked passive ${mode} recipients receive no new payload`, async () => {
    const server = await setup({ realtime: { enabled: true, authorize: () => true } });
    const victim = await server.loginAs("victim@example.com");
    const sender = await server.loginAs("sender@example.com");
    const a = await socket(server, `bunbase_session=${victim.sessionId}`);
    const b = await socket(server, `bunbase_session=${sender.sessionId}`);
    a.send({ type: `subscribe:${mode}`, channel: "room" });
    b.send({ type: `subscribe:${mode}`, channel: "room" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (mode === "broadcast") {
      b.send({ type: "broadcast", channel: "room", event: "before", payload: "before" });
      await until(() => a.messages.some((message) => message.event === "before"));
    } else await until(() => a.messages.some((message) => message.type === "presence:state"));
    a.messages.length = 0;
    await (server.db as any)
      .delete(internal.sessions)
      .where(eq(internal.sessions.id, victim.sessionId));
    b.send(
      mode === "broadcast"
        ? { type: "broadcast", channel: "room", event: "secret", payload: "secret" }
        : { type: "presence:update", channel: "room", meta: { secret: "secret" } },
    );
    await until(() => a.ws.readyState === WebSocket.CLOSED);
    expect(a.messages.some((message) => JSON.stringify(message).includes("secret"))).toBe(false);
  });
}

test("refresh racing user revocation cannot issue a surviving access token", async () => {
  const server = await setup({ auth: { jwt: { enabled: true, secret: jwtSecret } } });
  const user = await server.loginAs("race@example.com");
  const old = await tokens(user.userId);
  const original = crypto.subtle.sign.bind(crypto.subtle);
  const signing = spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
    const result = await original(...args);
    await revokeUserJwts(server.db, internal, user.userId);
    return result;
  });
  try {
    expect((await server.fetch("/auth/refresh", post({ refreshToken: old.refresh }))).status).toBe(
      401,
    );
  } finally {
    signing.mockRestore();
  }
});

test("realtime refreshes SQL rules and preserves anonymous public subscriptions", async () => {
  let scope = "first";
  const server = await setup(
    { realtime: { enabled: true, authorize: () => true } },
    {
      records: {
        list: () => eq(records.ownerId, scope),
        create: () => true,
        update: () => true,
        delete: () => true,
      },
    },
  );
  const conn = await socket(server);
  conn.send({ type: "subscribe:table", table: "records" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await server.fetch("/api/records", post({ id: "first", ownerId: "first", secret: "visible" }));
  await until(() => conn.messages.some((message) => message.id === "first"));
  conn.messages.length = 0;
  scope = "second";
  await server.fetch("/api/records/first", {
    ...post({ secret: "hidden-after-scope-change" }),
    method: "PATCH",
  });
  await server.fetch("/api/records/first", { method: "DELETE" });
  await server.fetch(
    "/api/records",
    post({ id: "second", ownerId: "second", secret: "now-visible" }),
  );
  await until(() => conn.messages.some((message) => message.id === "second"));
  expect(JSON.stringify(conn.messages)).not.toContain("hidden-after-scope-change");
  expect(conn.messages.find((message) => message.id === "second")?.record.secret).toBe(
    "now-visible",
  );
});

test("schema keys that collide with another column's SQL alias cannot bypass rules", async () => {
  const colliding = sqliteTable("colliding", {
    id: text("id").primaryKey(),
    ownerId: text("owner_id"),
    owner_id: text("label"),
  });
  const server = await createTestServer({
    schema: { users, colliding },
    rules: {
      colliding: {
        create: ({ body }) => body.ownerId === "victim",
        update: ({ body, record }) => !isChanged(body, record, "ownerId"),
      },
    },
  });
  servers.push(server);
  expect(
    (await server.fetch("/api/colliding", post({ id: "r", ownerId: "victim", label: "original" })))
      .status,
  ).toBe(201);
  const response = await server.fetch("/api/colliding/r", {
    ...post({ label: "attacker" }),
    method: "PATCH",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ownerId: "victim", owner_id: "attacker" });
  expect(
    (await server.fetch("/api/colliding/r", { ...post({ owner_id: "attacker" }), method: "PATCH" }))
      .status,
  ).toBe(400);
  expect((await server.fetch("/api/colliding", post({ id: "new", label: "victim" }))).status).toBe(
    403,
  );
});

test("profile changes preserve filtered realtime deletion invalidation", async () => {
  const server = await setup(
    { realtime: { enabled: true, authorize: () => true } },
    {
      records: {
        list: ({ auth }: any) => (auth ? eq(records.ownerId, auth.id) : false),
        delete: () => true,
      },
    },
  );
  const user = await server.loginAs("profile@example.com");
  await (server.db as any)
    .insert(records)
    .values({ id: "seeded", ownerId: user.userId, secret: "private" });
  const conn = await socket(server, `bunbase_session=${user.sessionId}`);
  conn.send({ type: "subscribe:table", table: "records" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await (server.db as any)
    .update(users)
    .set({ email: "changed@example.com" })
    .where(eq(users.id, user.userId));
  await server.fetch("/api/records/seeded", { method: "DELETE" });
  await until(() =>
    conn.messages.some((message) => message.id === "seeded" && message.action === "DELETE"),
  );
  expect(conn.messages.find((message) => message.id === "seeded")?.record).toBeUndefined();
});
