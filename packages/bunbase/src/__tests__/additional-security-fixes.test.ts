import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { signJwt, verifyJwt } from "../auth/jwt/core.ts";
import { createPasswordlessRoutes } from "../auth/passwordless.ts";
import { resolveConfig } from "../core/config.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { frontendRoute } from "../core/security-headers.ts";
import { loadServiceKey } from "../core/service-key-file.ts";
import { createDevMailServer } from "../mailer/dev-server.ts";
import { createSmtpTransport } from "../mailer/transports/smtp.ts";
import { handleWebSocketMessage } from "../realtime/handler.ts";
import { RealtimeManager } from "../realtime/manager.ts";
import { PresenceTracker } from "../realtime/presence.ts";
import { createTestServer, type TestServer } from "../testing/index.ts";
import { makeResolvedConfig } from "./test-helpers.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
});
const servers: TestServer[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.cleanup();
  for (const f of cleanup.splice(0)) f();
});
async function setup(config: Parameters<typeof createTestServer>[0]["config"] = {}) {
  const server = await createTestServer({
    schema: { users },
    config,
    rules: { users: { list: ({ auth }) => !!auth } },
  });
  servers.push(server);
  return server;
}
const secret = "additional-security-tests-secret";
const jwt = { enabled: true, secret, issuer: "https://issuer.example", audience: "mobile-app" };
const internal = getInternalSchema("sqlite");
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
async function token(id: string, overrides: Record<string, unknown> = {}) {
  return signJwt(
    {
      sub: id,
      email: "test@example.com",
      role: "user",
      type: "refresh",
      iss: jwt.issuer,
      aud: jwt.audience,
      ...overrides,
    },
    secret,
    3600,
  );
}

test("magic links ignore hostile request hosts and resolve to the actual verify route", async () => {
  const server = await setup();
  await server.loginAs("person@example.com");
  const sent: any[] = [];
  const config = resolveConfig({
    development: true,
    publicUrl: "https://accounts.example",
    auth: { mfa: { magicLink: { enabled: true } } },
  });
  const routes = createPasswordlessRoutes({
    db: server.db,
    internalSchema: internal,
    usersTable: users,
    config,
    mailer: {
      send: async (email: any) => {
        sent.push(email);
      },
    } as any,
  });
  const response = await routes["/auth/magic-link/request"]!.POST!(
    new Request("https://evil.example/auth/magic-link/request", {
      ...post({ email: "person@example.com" }),
      headers: { "x-forwarded-host": "also-evil.example" },
    }),
  );
  expect(response.status).toBe(200);
  const link = new URL(sent[0].html.match(/href="([^"]+)"/)[1]);
  expect(link.origin).toBe("https://accounts.example");
  expect(link.pathname).toBe("/auth/magic-link/verify");
  expect(link.searchParams.get("token")).toBeTruthy();
  expect(() =>
    createPasswordlessRoutes({
      db: server.db,
      internalSchema: internal,
      usersTable: users,
      config: { ...config, publicUrl: undefined },
      mailer: {} as any,
    }),
  ).toThrow("publicUrl");
  for (const publicUrl of [
    "http://evil.example",
    "https://user:pass@example.com",
    "https://example.com/subpath",
    "https://example.com/?q=x",
  ])
    expect(() => resolveConfig({ development: true, publicUrl })).toThrow();
  expect(resolveConfig({ development: true, publicUrl: "http://localhost:3000" }).publicUrl).toBe(
    "http://localhost:3000",
  );
});

test("service key publication is exclusive, repairs permissions, and rejects unsafe existing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "key-protection-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "key");
  const key = loadServiceKey(path);
  expect(key).toMatch(/^bb_sk_[a-f0-9]{32}$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  chmodSync(path, 0o644);
  expect(loadServiceKey(path)).toBe(key);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const link = join(dir, "link");
  symlinkSync(path, link);
  expect(() => loadServiceKey(link)).toThrow();
  writeFileSync(path, "invalid");
  expect(() => loadServiceKey(path)).toThrow("invalid service key");
  expect(readFileSync(path, "utf8")).toBe("invalid");
});

test("JWT issuer and audience isolate same-secret instances; malformed signatures fail closed", async () => {
  const server = await setup({ auth: { jwt } });
  const user = await server.loginAs("issuer@example.com");
  for (const overrides of [{ iss: "other" }, { aud: "other" }]) {
    const access = await token(user.userId, { ...overrides, type: "access" });
    expect(
      (await server.fetch("/api/users", { headers: { authorization: `Bearer ${access}` } })).status,
    ).toBe(403);
    expect(
      (
        await server.fetch(
          "/auth/refresh",
          post({ refreshToken: await token(user.userId, overrides) }),
        )
      ).status,
    ).toBe(401);
  }
  const access = await token(user.userId, { type: "access" });
  expect(
    (await server.fetch("/api/users", { headers: { authorization: `Bearer ${access}` } })).status,
  ).toBe(200);
  expect(await verifyJwt("a.b.%%%", secret)).toBeNull();
  expect(() =>
    resolveConfig({
      development: false,
      cors: { origins: ["https://app.example"] },
      auth: { jwt: { enabled: true, secret } },
    }),
  ).toThrow("issuer");
});

test("refresh rotates once, replay revokes the family, and unrelated families remain usable", async () => {
  const server = await setup({ auth: { jwt } });
  const user = await server.loginAs("rotate@example.com");
  const original = await token(user.userId);
  const refresh = (value: string) => server.fetch("/auth/refresh", post({ refreshToken: value }));
  const response = await refresh(original);
  expect(response.status).toBe(200);
  const pair = await response.json();
  expect(pair.refreshToken).not.toBe(original);
  expect(await verifyJwt(pair.accessToken, secret, server.db, internal, jwt)).not.toBeNull();
  expect((await refresh(original)).status).toBe(401);
  expect(await verifyJwt(pair.accessToken, secret, server.db, internal, jwt)).toBeNull();
  expect((await refresh(pair.refreshToken)).status).toBe(401);
  expect((await refresh(await token(user.userId))).status).toBe(200);
});

test("simultaneous refresh reuse cannot leave a surviving descendant", async () => {
  const server = await setup({ auth: { jwt } });
  const user = await server.loginAs("parallel@example.com");
  const original = await token(user.userId);
  const responses = await Promise.all(
    [1, 2].map(() => server.fetch("/auth/refresh", post({ refreshToken: original }))),
  );
  expect(responses.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  for (const response of responses)
    if (response.status === 200) {
      const pair = await response.json();
      expect(await verifyJwt(pair.accessToken, secret, server.db, internal, jwt)).toBeNull();
      expect(await verifyJwt(pair.refreshToken, secret, server.db, internal, jwt)).toBeNull();
    }
});

function socket(id: string) {
  const messages: any[] = [];
  const topics = new Set<string>();
  const closes: number[] = [];
  return {
    messages,
    closes,
    data: {
      auth: { id, email: `${id}@example.com`, role: "user" },
      connectedAt: Date.now(),
      presenceMeta: {},
    },
    subscribe: (topic: string) => topics.add(topic),
    unsubscribe: (topic: string) => topics.delete(topic),
    isSubscribed: (topic: string) => topics.has(topic),
    send: (raw: string) => messages.push(JSON.parse(raw)),
    close: (code: number) => closes.push(code),
  };
}
const send = (
  manager: RealtimeManager,
  presence: PresenceTracker,
  ws: ReturnType<typeof socket>,
  message: unknown,
) => handleWebSocketMessage(ws as any, JSON.stringify(message), {} as any, manager, presence);

test("channels deny by default, separate publish permission, recheck passive readers, and isolate topics", async () => {
  const presence = new PresenceTracker();
  const ws = socket("u");
  const denied = new RealtimeManager({} as any, {}, undefined, undefined, {}, presence);
  await send(denied, presence, ws, { type: "subscribe:broadcast", channel: "room" });
  expect(ws.messages.at(-1).message).toContain("denied");
  let readerAllowed = true;
  const manager = new RealtimeManager(
    {} as any,
    {},
    undefined,
    undefined,
    {
      authorize: ({ auth, channel, action }) => {
        if (channel === "throw") throw new Error("lookup failed");
        return auth.id === "writer" || (readerAllowed && action === "subscribe");
      },
    },
    presence,
  );
  const writer = socket("writer"),
    reader = socket("reader");
  await send(manager, presence, reader, { type: "subscribe:broadcast", channel: "room" });
  await send(manager, presence, reader, {
    type: "broadcast",
    channel: "room",
    event: "e",
    payload: 1,
  });
  expect(reader.messages.at(-1).message).toContain("denied");
  await send(manager, presence, writer, {
    type: "broadcast",
    channel: "room",
    event: "e",
    payload: 2,
  });
  expect(reader.messages.at(-1).payload).toBe(2);
  readerAllowed = false;
  await send(manager, presence, writer, {
    type: "broadcast",
    channel: "room",
    event: "e",
    payload: 3,
  });
  expect(reader.messages.some((m) => m.payload === 3)).toBe(false);
  await send(manager, presence, writer, {
    type: "subscribe:broadcast",
    channel: "presence:private",
  });
  await send(manager, presence, writer, { type: "subscribe:presence", channel: "private" });
  const before = writer.messages.length;
  await send(manager, presence, writer, {
    type: "broadcast",
    channel: "private",
    event: "e",
    payload: "injected",
  });
  expect(writer.messages.length).toBe(before);
  await send(manager, presence, writer, { type: "subscribe:broadcast", channel: "throw" });
  expect(writer.messages.at(-1).message).toContain("denied");
});

test("realtime validates shape, size, depth, subscription races, rate, and cumulative metadata", async () => {
  const presence = new PresenceTracker(30);
  const manager = new RealtimeManager(
    {} as any,
    {},
    undefined,
    undefined,
    {
      authorize: () => true,
      limits: { maxSubscriptions: 1, messagesPerWindow: 100, maxDataBytes: 30, maxDepth: 4 },
    },
    presence,
  );
  const ws = socket("u");
  for (const message of [
    null,
    { type: "subscribe:broadcast", channel: {} },
    { type: "subscribe:presence", channel: "room", meta: [] },
    { type: "broadcast", channel: "room", event: "e", payload: "x".repeat(50) },
    { type: "broadcast", channel: "room", event: "e", payload: { a: { b: { c: { d: 1 } } } } },
  ]) {
    await send(manager, presence, ws, message);
    expect(ws.messages.at(-1).type).toBe("error");
  }
  await Promise.all(
    ["a", "b", "c"].map((channel) =>
      send(manager, presence, ws, { type: "subscribe:broadcast", channel }),
    ),
  );
  expect(manager.subscriptionCount(ws as any)).toBe(1);
  presence.join("room", "u", { one: "1234567890" }, ws);
  expect(() => presence.updateMeta("room", "u", { two: "1234567890" })).toThrow();
  expect(presence.getUsers("room")[0]!.meta).toEqual({ one: "1234567890" });
  const limited = new RealtimeManager({} as any, {}, undefined, undefined, {
    limits: { messagesPerWindow: 2 },
  });
  const flood = socket("flood");
  for (let i = 0; i < 3; i++) await send(limited, presence, flood, null);
  expect(flood.closes).toContain(1008);
  const release = limited.reserveConnection("127.0.0.1", "u")!;
  const cap = new RealtimeManager({} as any, {}, undefined, undefined, {
    limits: { maxConnectionsPerIp: 1 },
  });
  const releaseCap = cap.reserveConnection("ip")!;
  expect(cap.reserveConnection("ip")).toBeNull();
  releaseCap();
  expect(cap.reserveConnection("ip")).not.toBeNull();
  release();
});

test("browser headers cover admin, errors, auth HTML, and built production SPA assets", async () => {
  const server = await setup();
  for (const path of [
    "/_admin",
    "/_admin/users",
    "/_admin-assets/invalid%2fpath",
    "/missing",
    "/auth/verify-email?token=bad",
    "/health",
  ]) {
    const response = await server.fetch(path);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
  const dir = mkdtempSync(join(tmpdir(), "secure-frontend-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "app.js"), "document.body.dataset.loaded = 'true';");
  writeFileSync(
    join(dir, "index.html"),
    '<html><head><script type="module" src="./app.js"></script></head><body>SPA</body></html>',
  );
  const route = frontendRoute(
    { index: join(dir, "index.html") },
    makeResolvedConfig({ secureDefaults: true }),
  ) as (r: Request) => Promise<Response>;
  const html = await route(new Request("https://app.example/deep/link"));
  expect(html.headers.get("content-security-policy")).toContain("script-src 'self';");
  const body = await html.text();
  const asset = body.match(/src="([^"]+\.js)"/)![1]!;
  const script = await route(new Request(new URL(asset, "https://app.example/deep/link")));
  expect(script.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await script.text()).toContain("loaded");
});

test("dev email HTML is sandboxed through SMTP and safe links remain available", async () => {
  const mail = createDevMailServer({ smtpPort: 0, httpPort: 0 });
  cleanup.push(() => mail.stop());
  const transport = createSmtpTransport({ host: "localhost", port: (mail.smtp as any).port });
  await transport({
    from: "sender@example.com",
    to: "to@example.com",
    subject: "Hostile HTML",
    html: '<img src=x onerror="parent.__emailExecuted=true"><script>parent.__emailExecuted=true</script><a href="https://example.com">Link</a>',
  });
  const response = await fetch(new URL(`/api/emails/${mail.emails[0]!.id}/html`, mail.http.url));
  expect(response.headers.get("content-security-policy")).toContain("sandbox;");
  expect(response.headers.get("content-security-policy")).not.toContain("allow-scripts");
  const ui = await (await fetch(mail.http.url)).text();
  expect(ui).toContain("frame.setAttribute('sandbox', '')");
  expect(ui).not.toContain("shadow.innerHTML");
});

test("presence authorization lost during join never exposes state or retains membership", async () => {
  for (const allowedChecks of [1, 2]) {
    const presence = new PresenceTracker();
    const existing = socket("existing");
    presence.join("private", "existing", { secret: "private metadata" }, existing);
    let checks = 0;
    const manager = new RealtimeManager(
      {} as any,
      {},
      undefined,
      undefined,
      { authorize: () => ++checks <= allowedChecks },
      presence,
    );
    const newcomer = socket("newcomer");
    await send(manager, presence, newcomer, { type: "subscribe:presence", channel: "private" });
    expect(newcomer.messages.some((m) => m.type === "presence:state")).toBe(false);
    expect(manager.hasChannel(newcomer as any, "presence", "private")).toBe(false);
    expect(presence.getUsers("private").some((u) => u.userId === "newcomer")).toBe(false);
  }
});

test("closing while channel authorization is pending cannot resurrect a subscription", async () => {
  let complete!: (allow: boolean) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const manager = new RealtimeManager({} as any, {}, undefined, undefined, {
    authorize: () => {
      started();
      return new Promise<boolean>((resolve) => {
        complete = resolve;
      });
    },
  });
  const ws = socket("disconnected");
  const pending = manager.subscribeChannel(ws as any, "broadcast", "room");
  await entered;
  manager.removeAllSubscriptions(ws as any);
  complete(true);
  expect(await pending).toBe(false);
  expect(manager.subscriptionCount(ws as any)).toBe(0);
});

test("concurrent processes load one exclusively published service credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "key-race-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "key");
  const module = new URL("../core/service-key-file.ts", import.meta.url).pathname;
  const source = `import {loadServiceKey} from ${JSON.stringify(module)}; console.log(Bun.hash(loadServiceKey(${JSON.stringify(file)})).toString());`;
  const processes = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" }),
  );
  const hashes = await Promise.all(
    processes.map(async (child) => {
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return text;
    }),
  );
  expect(new Set(hashes).size).toBe(1);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("plain-text SMTP markup remains text and safe-link extraction rejects active URL schemes", async () => {
  const mail = createDevMailServer({ smtpPort: 0, httpPort: 0 });
  cleanup.push(() => mail.stop());
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: "localhost",
      port: (mail.smtp as any).port,
      socket: {
        open(socket) {
          socket.write(
            "EHLO test\r\nMAIL FROM:<from@example.com>\r\nRCPT TO:<to@example.com>\r\nDATA\r\nSubject: Plain text\r\nContent-Type: text/plain\r\n\r\n<img src=x onerror=alert(1)>\r\n.\r\nQUIT\r\n",
          );
        },
        data() {},
        close() {
          resolve();
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
  expect(mail.emails[0]!.html).toContain("&lt;img");
  expect(mail.emails[0]!.html).not.toContain("<img");
  mail.emails[0]!.html =
    '<a href="javascript:alert(1)">Bad</a><a href="data:text/html,test">Bad</a><a href="https://example.com/verify?t=test">Good</a>';
  const detail = await (
    await fetch(new URL(`/api/emails/${mail.emails[0]!.id}`, mail.http.url))
  ).json();
  expect(detail.links).toEqual(["https://example.com/verify?t=test"]);
});

test("real WebSocket routes keep independent payload limits and failed upgrades release quotas", async () => {
  const server = await createTestServer({
    schema: { users },
    config: { realtime: { enabled: true, limits: { maxConnectionsPerIp: 1 } } },
    extend: () => ({
      "/small": {
        websocket: {
          maxPayloadLength: 16,
          message(ws) {
            ws.send("accepted");
          },
        },
      },
      "/large": {
        websocket: {
          maxPayloadLength: 100000,
          message(ws) {
            ws.send("accepted");
          },
        },
      },
    }),
  });
  servers.push(server);
  async function open(path: string): Promise<WebSocket> {
    const ws = new WebSocket(server.baseUrl.replace(/^http/, "ws") + path);
    cleanup.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket failed"));
    });
    return ws;
  }
  const small = await open("/small");
  const closed = new Promise<number>((resolve) => {
    small.onclose = (event) => resolve(event.code);
  });
  small.send("x".repeat(1000));
  expect(await closed).toBe(1009);
  const large = await open("/large");
  const echoed = new Promise<string>((resolve) => {
    large.onmessage = (event) => resolve(event.data);
  });
  large.send("x".repeat(1000));
  expect(await echoed).toBe("accepted");
  for (let i = 0; i < 3; i++) expect((await server.fetch("/realtime")).status).toBe(400);
  const realtime = await open("/realtime");
  const rejected = new Promise<string>((resolve) => {
    realtime.onmessage = (event) => resolve(event.data);
  });
  realtime.send(
    JSON.stringify({
      type: "broadcast",
      channel: "room",
      event: "large",
      payload: "x".repeat(70000),
    }),
  );
  expect(JSON.parse(await rejected).type).toBe("error");
});
