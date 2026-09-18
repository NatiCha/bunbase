import { afterAll, describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { resetRateLimit } from "../auth/rate-limit.ts";
import { allowAll } from "../rules/helpers.ts";
import { createTestServer } from "../testing/index.ts";

/**
 * Security tests for organization owner-escalation blocks (finding 6) and
 * passwordless account-deletion confirmation (finding 8).
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

function sessionCookie(res: Response): string | null {
  for (const c of res.headers.getAll("set-cookie")) {
    if (c.startsWith("bunbase_session=")) return c.split(";")[0]!;
  }
  return null;
}

function makeFetch(baseUrl: string) {
  return (path: string, init: RequestInit = {}, session?: string | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("x-csrf-token", csrfToken);
    let cookie = `csrf_token=${csrfToken}`;
    if (session) cookie += `; ${session}`;
    headers.set("cookie", cookie);
    return globalThis.fetch(`${baseUrl}${path}`, { ...init, headers });
  };
}

// ─── Finding 6: org owner self-escalation blocks ───

const orgServer = await createTestServer({
  schema: { users },
  rules: { users: allowAll },
  config: {
    auth: {
      rateLimit: { max: 10000 },
      organizations: { enabled: true },
    },
  },
});
afterAll(() => orgServer.cleanup());

const f = makeFetch(orgServer.baseUrl);

async function registerAndSession(email: string): Promise<{ session: string; id: string }> {
  const res = await f("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123" }),
  });
  const session = sessionCookie(res)!;
  const row = await orgServer.adapter.rawQueryOne<{ id: string }>(
    "SELECT id FROM users WHERE email = $email",
    { $email: email },
  );
  return { session, id: row!.id };
}

describe("org owner escalation", () => {
  test("an admin cannot promote a member to owner via member-update", async () => {
    const owner = await registerAndSession("orgowner1@test.com");
    const admin = await registerAndSession("orgadmin1@test.com");
    const member = await registerAndSession("orgmember1@test.com");

    // Owner creates org.
    const createRes = await f(
      "/auth/organizations",
      { method: "POST", body: JSON.stringify({ name: "Acme One" }) },
      owner.session,
    );
    expect(createRes.status).toBe(201);
    const orgId = (await createRes.json()).organization.id;

    // Owner invites admin + member, who accept (seed memberships directly for speed).
    const now = new Date().toISOString();
    await orgServer.adapter.rawExecute(
      "INSERT INTO _organization_members (id, org_id, user_id, role, created_at) VALUES ($id,$o,$u,'admin',$n)",
      { $id: crypto.randomUUID(), $o: orgId, $u: admin.id, $n: now },
    );
    await orgServer.adapter.rawExecute(
      "INSERT INTO _organization_members (id, org_id, user_id, role, created_at) VALUES ($id,$o,$u,'member',$n)",
      { $id: crypto.randomUUID(), $o: orgId, $u: member.id, $n: now },
    );

    // Admin tries to promote the member to owner — must be forbidden.
    const promoteRes = await f(
      `/auth/organizations/${orgId}/members/${member.id}`,
      { method: "PATCH", body: JSON.stringify({ role: "owner" }) },
      admin.session,
    );
    expect(promoteRes.status).toBe(403);

    // Admin tries to promote THEMSELVES to owner — must be forbidden.
    const selfPromote = await f(
      `/auth/organizations/${orgId}/members/${admin.id}`,
      { method: "PATCH", body: JSON.stringify({ role: "owner" }) },
      admin.session,
    );
    expect(selfPromote.status).toBe(403);

    // Admin can still legitimately change a member to admin.
    const legitRes = await f(
      `/auth/organizations/${orgId}/members/${member.id}`,
      { method: "PATCH", body: JSON.stringify({ role: "admin" }) },
      admin.session,
    );
    expect(legitRes.status).toBe(200);
  });

  test("an admin cannot create an owner-role invite", async () => {
    const owner = await registerAndSession("orgowner2@test.com");
    const admin = await registerAndSession("orgadmin2@test.com");

    const createRes = await f(
      "/auth/organizations",
      { method: "POST", body: JSON.stringify({ name: "Acme Two" }) },
      owner.session,
    );
    const orgId = (await createRes.json()).organization.id;
    await orgServer.adapter.rawExecute(
      "INSERT INTO _organization_members (id, org_id, user_id, role, created_at) VALUES ($id,$o,$u,'admin',$n)",
      { $id: crypto.randomUUID(), $o: orgId, $u: admin.id, $n: new Date().toISOString() },
    );

    const inviteRes = await f(
      `/auth/organizations/${orgId}/invites`,
      { method: "POST", body: JSON.stringify({ email: "newbie@test.com", role: "owner" }) },
      admin.session,
    );
    expect(inviteRes.status).toBe(403);
  });

  test("owner can transfer ownership; old owner becomes admin", async () => {
    const owner = await registerAndSession("orgowner3@test.com");
    const target = await registerAndSession("orgtarget3@test.com");

    const createRes = await f(
      "/auth/organizations",
      { method: "POST", body: JSON.stringify({ name: "Acme Three" }) },
      owner.session,
    );
    const orgId = (await createRes.json()).organization.id;
    await orgServer.adapter.rawExecute(
      "INSERT INTO _organization_members (id, org_id, user_id, role, created_at) VALUES ($id,$o,$u,'member',$n)",
      { $id: crypto.randomUUID(), $o: orgId, $u: target.id, $n: new Date().toISOString() },
    );

    const transferRes = await f(
      `/auth/organizations/${orgId}/transfer-ownership`,
      { method: "POST", body: JSON.stringify({ userId: target.id }) },
      owner.session,
    );
    expect(transferRes.status).toBe(200);

    const roles = await orgServer.adapter.rawQuery<{ user_id: string; role: string }>(
      "SELECT user_id, role FROM _organization_members WHERE org_id = $o",
      { $o: orgId },
    );
    const ownerRole = roles.find((r) => r.user_id === owner.id)?.role;
    const targetRole = roles.find((r) => r.user_id === target.id)?.role;
    expect(targetRole).toBe("owner");
    expect(ownerRole).toBe("admin");

    // The former owner (now admin) cannot transfer ownership.
    const reTransfer = await f(
      `/auth/organizations/${orgId}/transfer-ownership`,
      { method: "POST", body: JSON.stringify({ userId: owner.id }) },
      owner.session,
    );
    expect(reTransfer.status).toBe(403);
  });
});

// ─── Finding 8: passwordless account deletion requires typed-email confirm ───

const delServer = await createTestServer({
  schema: { users },
  rules: { users: allowAll },
  config: { auth: { rateLimit: { max: 10000 } } },
});
afterAll(() => delServer.cleanup());
// Reclaim the shared rate-limit budget for later test files.
afterAll(() => resetRateLimit());

const fd = makeFetch(delServer.baseUrl);

describe("passwordless account deletion", () => {
  test("password account: requires password", async () => {
    const res = await fd("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "haspw@test.com", password: "password123" }),
    });
    const session = sessionCookie(res)!;

    // Wrong password is rejected.
    const bad = await fd(
      "/auth/delete-account",
      { method: "POST", body: JSON.stringify({ password: "wrong" }) },
      session,
    );
    expect(bad.status).toBe(401);

    // Correct password deletes.
    const ok = await fd(
      "/auth/delete-account",
      { method: "POST", body: JSON.stringify({ password: "password123" }) },
      session,
    );
    expect(ok.status).toBe(200);
  });

  test("passwordless account: deletion needs typed-email confirmation", async () => {
    // Seed a passwordless user (empty password hash) + a session directly.
    const userId = crypto.randomUUID();
    await delServer.adapter.rawExecute(
      "INSERT INTO users (id, email, password_hash, role, email_verified) VALUES ($id,$e,'','user',1)",
      { $id: userId, $e: "nopw@test.com" },
    );
    const sessionId = crypto.randomUUID();
    await delServer.adapter.rawExecute(
      "INSERT INTO _sessions (id, user_id, expires_at, mfa_verified, created_at) VALUES ($id,$u,$exp,1,$now)",
      {
        $id: sessionId,
        $u: userId,
        $exp: Math.floor(Date.now() / 1000) + 3600,
        $now: new Date().toISOString(),
      },
    );
    const session = `bunbase_session=${sessionId}`;

    // Without confirmEmail → rejected (no silent deletion).
    const noConfirm = await fd(
      "/auth/delete-account",
      { method: "POST", body: JSON.stringify({}) },
      session,
    );
    expect(noConfirm.status).toBe(400);

    // Wrong email → rejected.
    const wrongEmail = await fd(
      "/auth/delete-account",
      { method: "POST", body: JSON.stringify({ confirmEmail: "other@test.com" }) },
      session,
    );
    expect(wrongEmail.status).toBe(400);

    // Correct typed email → deletes.
    const ok = await fd(
      "/auth/delete-account",
      { method: "POST", body: JSON.stringify({ confirmEmail: "nopw@test.com" }) },
      session,
    );
    expect(ok.status).toBe(200);
  });
});
