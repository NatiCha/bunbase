import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { getInternalSchema } from "../core/internal-schema.ts";
import { orgAdmin, orgMember, orgOwner, ownerOnly } from "../rules/helpers.ts";
import type { TableRules } from "../rules/types.ts";
import { createTestServer, type TestServer } from "../testing/index.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull(),
});
const posts = sqliteTable("private_posts", {
  id: text("id").primaryKey(),
  authorId: text("author_id").notNull(),
  title: text("title"),
});

async function upload(server: TestServer, sessionId: string, recordId: string) {
  const form = new FormData();
  form.set("file", new File(["original bytes"], "note.txt", { type: "text/plain" }));
  const response = await fetch(`${server.baseUrl}/files/private_posts/${recordId}`, {
    method: "POST",
    headers: { cookie: `bunbase_session=${sessionId}; csrf_token=test`, "x-csrf-token": "test" },
    body: form,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { file: { id: string } }).file.id;
}

for (const policy of ["sql", "record", "deny", "missing", "throw"] as const) {
  test(`file deletion enforces ${policy} rules and preserves denied files`, async () => {
    const deleteRule: TableRules["delete"] =
      policy === "sql"
        ? ({ auth }) => ownerOnly(posts.authorId, auth)
        : policy === "record"
          ? ({ record, auth }) => record?.authorId === auth?.id
          : policy === "deny"
            ? () => false
            : policy === "throw"
              ? () => {
                  throw new Error("Authorization lookup failed");
                }
              : undefined;
    const server = await createTestServer({
      schema: { users, posts },
      rules: {
        private_posts: {
          create: ({ auth }) => !!auth,
          get: ({ auth }) => ownerOnly(posts.authorId, auth),
          delete: deleteRule,
        },
      },
    });
    try {
      const owner = await server.loginAs({ id: "owner" });
      const outsider = await server.loginAs({ id: "outsider" });
      await (server.db as SQLiteBunDatabase)
        .insert(posts)
        .values({ id: "private", authorId: owner.userId });
      const fileId = await upload(server, owner.sessionId, "private");
      expect((await server.fetch(`/files/${fileId}`, { method: "DELETE" })).status).toBe(401);
      expect((await outsider.fetch(`/files/${fileId}`, { method: "DELETE" })).status).toBe(403);
      const preserved = await owner.fetch(`/files/${fileId}`);
      expect(preserved.status).toBe(200);
      expect(await preserved.text()).toBe("original bytes");
      const allowed = policy === "sql" || policy === "record";
      expect((await owner.fetch(`/files/${fileId}`, { method: "DELETE" })).status).toBe(
        allowed ? 200 : 403,
      );
      expect((await owner.fetch(`/files/${fileId}`)).status).toBe(allowed ? 404 : 200);
    } finally {
      server.cleanup();
    }
  });
}

test("file deletion denies orphaned records even with an unconditional allow rule", async () => {
  const server = await createTestServer({
    schema: { users, posts },
    rules: { private_posts: { create: () => true, delete: () => true } },
  });
  try {
    const owner = await server.loginAs({ id: "owner" });
    await (server.db as SQLiteBunDatabase)
      .insert(posts)
      .values({ id: "removed", authorId: owner.userId });
    const fileId = await upload(server, owner.sessionId, "removed");
    await (server.db as SQLiteBunDatabase).delete(posts).where(eq(posts.id, "removed"));
    expect((await owner.fetch(`/files/${fileId}`, { method: "DELETE" })).status).toBe(403);
    const files = getInternalSchema("sqlite").files;
    expect(await (server.db as any).select().from(files).where(eq(files.id, fileId))).toHaveLength(
      1,
    );
  } finally {
    server.cleanup();
  }
});

const documents = sqliteTable("org_documents", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  content: text("content"),
});

for (const [name, helper, allowedRoles] of [
  ["orgMember", orgMember, ["member", "admin", "owner"]],
  ["orgAdmin", orgAdmin, ["admin", "owner"]],
  ["orgOwner", orgOwner, ["owner"]],
] as const) {
  test(`${name} enforces persisted organization membership and role through HTTP`, async () => {
    const schema = getInternalSchema("sqlite");
    const server = await createTestServer({
      schema: { users, documents },
      rules: {
        org_documents: {
          update: ({ record, auth, db }) => helper(record?.orgId as string, auth, db),
        },
      },
    });
    try {
      await (server.db as SQLiteBunDatabase)
        .insert(documents)
        .values({ id: "private", orgId: "target-org", content: "original" });
      for (const role of ["outsider", "member", "admin", "owner", "unknown"]) {
        // A global admin outside this organization is still a nonmember.
        const session = await server.loginAs({
          id: role,
          role: role === "outsider" ? "admin" : "user",
        });
        await (server.db as any).insert(schema.organizationMembers).values({
          id: role,
          orgId: role === "outsider" ? "other-org" : "target-org",
          userId: session.userId,
          role: role === "outsider" ? "owner" : role,
          createdAt: new Date().toISOString(),
        });
        const response = await session.fetch("/api/org_documents/private", {
          method: "PATCH",
          body: JSON.stringify({ content: role }),
        });
        const allowed = (allowedRoles as readonly string[]).includes(role);
        expect(response.status).toBe(allowed ? 200 : 403);
        if (!allowed) {
          const [row] = await (server.db as SQLiteBunDatabase).select().from(documents);
          expect(row!.content).not.toBe(role);
        }
      }
      const owner = { id: "owner", email: "owner@example.com", role: "user" };
      expect(await helper("target-org", null, server.db)).toBe(false);
      expect(await helper(undefined, owner, server.db)).toBe(false);
      expect(await helper("missing-org", owner, server.db)).toBe(false);
      // Legacy JavaScript calls must fail closed, even without typechecking.
      // @ts-expect-error The database is required by the updated public API.
      expect(await helper("target-org", owner)).toBe(false);
      await (server.db as any)
        .delete(schema.organizationMembers)
        .where(eq(schema.organizationMembers.userId, owner.id));
      expect(await helper("target-org", owner, server.db)).toBe(false);
      await server.adapter.rawExecute("DROP TABLE _organization_members");
      const session = await server.loginAs({ id: "owner" });
      expect(
        (
          await session.fetch("/api/org_documents/private", {
            method: "PATCH",
            body: JSON.stringify({ content: "lookup-failed" }),
          })
        ).status,
      ).toBe(403);
    } finally {
      server.cleanup();
    }
  });
}
