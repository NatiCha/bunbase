import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { encrypt } from "../auth/encryption.ts";
import { generateSecret, generateTotpCode } from "../auth/mfa/totp-core.ts";
import { hashPassword } from "../auth/passwords.ts";
import { resetRateLimit } from "../auth/rate-limit.ts";
import { hashToken } from "../auth/tokens.ts";
import { BunBaseClientError, createBunBaseClient } from "../client.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { defineRelations } from "../crud/relations.ts";
import { allowAll } from "../rules/helpers.ts";
import {
  type CreateTestServerOptions,
  createTestServer,
  type TestServer,
} from "../testing/index.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  secret: text("secret"),
  phone: text("phone"),
});
const internal = getInternalSchema("sqlite");
const encryptionKey = "regression-test-mfa-key";
const password = "regression-password";

async function withServer(
  options: CreateTestServerOptions,
  run: (server: TestServer) => Promise<void>,
) {
  const server = await createTestServer(options);
  try {
    await run(server);
  } finally {
    server.cleanup();
    resetRateLimit();
  }
}

async function seedMfa(server: TestServer) {
  const secret = generateSecret().base32;
  await (server.db as any).insert(users).values({
    id: "mfa-user",
    email: "mfa@example.com",
    passwordHash: await hashPassword(password),
    role: "user",
    phone: "+15555550123",
  });
  await (server.db as any).insert(internal.mfaTotp).values({
    id: "totp",
    userId: "mfa-user",
    encryptedSecret: await encrypt(secret, encryptionKey),
    verified: 1,
    createdAt: new Date().toISOString(),
  });
  return secret;
}

const mfaConfig = {
  auth: {
    rateLimit: { max: 10000 },
    mfa: {
      encryptionKey,
      totp: { enabled: true },
      magicLink: { enabled: true },
      otp: { enabled: true },
      smsOtp: { enabled: true },
    },
  },
};

test("pending MFA sessions cannot regenerate backup codes, disable MFA, or alter enrollment", async () => {
  await withServer({ schema: { users }, config: mfaConfig }, async (server) => {
    const secret = await seedMfa(server);
    const login = await server.fetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "mfa@example.com", password }),
    });
    expect(await login.json()).toMatchObject({ mfaRequired: true });
    const session = login.headers
      .getAll("set-cookie")
      .find((c) => c.startsWith("bunbase_session="))!
      .split(";")[0];
    const request = (path: string, body?: unknown) =>
      fetch(server.baseUrl + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie: `${session}; csrf_token=test`,
          "x-csrf-token": "test",
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await request("/auth/me")).status).toBe(401);
    for (const path of [
      "/auth/mfa/backup/regenerate",
      "/auth/mfa/totp/disable",
      "/auth/mfa/totp/setup",
      "/auth/mfa/totp/verify-setup",
    ]) {
      expect((await request(path, { password, code: generateTotpCode(secret) })).status).toBe(401);
    }
    expect((await request("/auth/mfa/status")).status).toBe(200);
    expect(
      (await request("/auth/mfa/totp/verify", { code: generateTotpCode(secret) })).status,
    ).toBe(200);
    expect((await request("/auth/me")).status).toBe(200);
    expect((await request("/auth/mfa/backup/regenerate", { password })).status).toBe(200);
  });
});

const owners = sqliteTable("private_owners", {
  id: text("id").primaryKey(),
  name: text("name"),
  secret: text("private_secret"),
  passwordDigest: text("password_hash"),
});
const items = sqliteTable("private_items", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
  secret: text("private_secret"),
  category: text("category"),
});
const relationSchema = { owners, items };
const relations = defineRelations(relationSchema, (r) => ({
  items: { owner: r.one.owners({ from: r.items.ownerId, to: r.owners.id }) },
  owners: { items: r.many.items() },
}));

test("custom hidden columns and aliased password columns stay hidden in to-one and to-many list/get expansions", async () => {
  await withServer(
    {
      schema: relationSchema,
      relations,
      fields: {
        private_owners: { hidden: ["private_secret"] },
        private_items: { hidden: ["secret"] },
      },
      rules: { private_owners: allowAll, private_items: allowAll },
    },
    async (server) => {
      await (server.db as any).insert(owners).values([
        { id: "o1", name: "Owner", secret: "owner-secret", passwordDigest: "hash" },
        { id: "o2", name: "Empty" },
      ]);
      await (server.db as any).insert(items).values([
        { id: "i1", ownerId: "o1", secret: "item-secret" },
        { id: "i2", ownerId: null, secret: "item-secret" },
      ]);
      for (const path of [
        "/api/private_items?expand=owner",
        "/api/private_items/i1?expand=owner",
        "/api/private_owners?expand=items",
        "/api/private_owners/o1?expand=items",
      ]) {
        const res = await server.fetch(path);
        expect(res.status).toBe(200);
        const data = await res.json();
        const serialized = JSON.stringify(data);
        expect(serialized).not.toContain("owner-secret");
        expect(serialized).not.toContain("item-secret");
        expect(serialized).not.toContain("passwordDigest");
        expect(serialized).toContain("Owner");
      }
      expect(
        (await (await server.fetch("/api/private_items/i2?expand=owner")).json()).owner,
      ).toBeNull();
      expect(
        (await (await server.fetch("/api/private_owners/o2?expand=items")).json()).items,
      ).toEqual([]);
    },
  );
});

test("SDK totals include authorized filtered rows regardless of the cursor or direction", async () => {
  await withServer(
    { schema: { items }, rules: { private_items: { list: () => eq(items.ownerId, "allowed") } } },
    async (server) => {
      await (server.db as any)
        .insert(items)
        .values([
          ...["a", "b", "c"].map((id) => ({ id, ownerId: "allowed", category: "selected" })),
          { id: "d", ownerId: "denied", category: "selected" },
          { id: "e", ownerId: "allowed", category: "other" },
        ]);
      const client = createBunBaseClient({ url: server.baseUrl, schema: { items } });
      expect((await client.api.items.list()).total).toBeUndefined();
      for (const order of ["asc", "desc"] as const) {
        let cursor: string | undefined;
        let visited = 0;
        do {
          const page = await client.api.items.list({
            count: true,
            limit: 1,
            order,
            filter: { category: "selected" },
            cursor,
          });
          expect(page.total).toBe(3);
          visited += page.data.length;
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(visited).toBe(3);
      }
    },
  );
});

test("mandatory MFA remains isolated across instances, including admin and file routes", async () => {
  const strict = await createTestServer({
    schema: { users },
    rules: { users: { list: ({ auth }) => !!auth } },
    config: { auth: { mfa: { required: true, totp: { enabled: true }, encryptionKey } } },
  });
  try {
    const user = await strict.loginAs({ email: "unenrolled@example.com", role: "admin" });
    const check = async () => {
      expect((await user.fetch("/api/users")).status).toBe(403);
      expect((await user.fetch("/_admin/api/stats")).status).toBe(401);
      expect((await user.fetch("/files/missing")).status).toBe(401);
      expect((await user.fetch("/auth/me")).status).toBe(200);
    };
    await check();
    await withServer(
      { schema: { users }, rules: { users: { list: ({ auth }) => !!auth } } },
      async (relaxed) => {
        expect(
          (await (await relaxed.loginAs("relaxed@example.com")).fetch("/api/users")).status,
        ).toBe(200);
        await check();
        const enrollment = await user.fetch("/auth/mfa/totp/setup", { method: "POST" });
        expect(enrollment.status).toBe(200);
        const { secret } = await enrollment.json();
        expect(
          (
            await user.fetch("/auth/mfa/totp/verify-setup", {
              method: "POST",
              body: JSON.stringify({ code: generateTotpCode(secret) }),
            })
          ).status,
        ).toBe(200);
        expect((await user.fetch("/api/users")).status).toBe(200);
      },
    );
  } finally {
    strict.cleanup();
  }
});

test("SDK supports passwordless email confirmation and retains the password shorthand", async () => {
  await withServer({ schema: { users } }, async (server) => {
    for (const hasPassword of [false, true]) {
      const email = `delete-${hasPassword}@example.com`;
      const user = await server.loginAs(email);
      await (server.db as any)
        .update(users)
        .set({ passwordHash: hasPassword ? await hashPassword(password) : null })
        .where(eq(users.id, user.userId));
      const keyRes = await user.fetch("/auth/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: "test" }),
      });
      expect(keyRes.status).toBe(201);
      const { key } = await keyRes.json();
      const client = createBunBaseClient({ url: server.baseUrl, schema: { users }, apiKey: key });
      if (!hasPassword) {
        await expect(
          client.auth.deleteAccount({ confirmEmail: "wrong@example.com" }),
        ).rejects.toBeInstanceOf(BunBaseClientError);
      }
      expect(
        await client.auth.deleteAccount(hasPassword ? password : { confirmEmail: email }),
      ).toEqual({ deleted: true });
      expect(
        await (server.db as any).select().from(users).where(eq(users.id, user.userId)),
      ).toEqual([]);
    }
  });
});

test("SDK magic-link, email OTP and SMS OTP verification return MFA challenges without emitting login", async () => {
  await withServer({ schema: { users }, config: mfaConfig }, async (server) => {
    await seedMfa(server);
    const client = createBunBaseClient({ url: server.baseUrl, schema: { users } });
    const events: unknown[] = [];
    client.auth.onAuthStateChange((state) => events.push(state));
    for (const type of ["magic_link", "email_otp", "sms_otp"] as const) {
      const token = type === "magic_link" ? "regression-magic-token" : "123456";
      await (server.db as any).insert(internal.verificationTokens).values({
        id: type,
        userId: "mfa-user",
        tokenHash: await hashToken(token),
        type,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        createdAt: new Date().toISOString(),
      });
      const result =
        type === "magic_link"
          ? await client.auth.magicLink.verify(token)
          : type === "email_otp"
            ? await client.auth.otp.verify("mfa@example.com", token)
            : await client.auth.smsOtp.verify("+15555550123", token);
      expect(result).toEqual({ mfaRequired: true, mfaMethods: ["totp"] });
    }
    expect(events).toEqual([]);
  });
});

test("invite-required registration accepts control fields while rejecting arbitrary user fields", async () => {
  await withServer(
    {
      schema: { users },
      config: {
        auth: { rateLimit: { max: 10000 }, invitations: { enabled: true, required: true } },
      },
    },
    async (server) => {
      const admin = await server.loginAs({ email: "inviter@example.com", role: "admin" });
      const inviteResponse = await admin.fetch("/auth/invites", {
        method: "POST",
        body: JSON.stringify({ maxUses: 1, role: "user" }),
      });
      expect(inviteResponse.status).toBe(201);
      const { invite } = await inviteResponse.json();
      const client = createBunBaseClient({ url: server.baseUrl, schema: { users } });
      await expect(
        client.auth.register({
          email: "invited@example.com",
          password,
          inviteCode: invite.token,
          unknown: "bad",
        }),
      ).rejects.toBeInstanceOf(BunBaseClientError);
      const registered = await client.auth.register({
        email: "invited@example.com",
        password,
        inviteCode: invite.token,
      });
      expect(registered.user.email).toBe("invited@example.com");
      await expect(
        client.auth.register({ email: "extra@example.com", password, inviteCode: invite.token }),
      ).rejects.toBeInstanceOf(BunBaseClientError);
      const rows = await (server.db as any)
        .select()
        .from(users)
        .where(eq(users.email, "extra@example.com"));
      expect(rows).toEqual([]);
    },
  );
});
