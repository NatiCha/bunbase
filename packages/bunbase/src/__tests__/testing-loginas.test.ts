import { afterAll, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createTestServer } from "../testing/index.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
});

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id").notNull(),
});

const server = await createTestServer({
  schema: { users, posts },
  rules: {
    posts: {
      list: () => true,
      // create only allowed for authenticated users — exercises the session cookie.
      create: ({ auth }) => auth !== null,
    },
  },
});

afterAll(() => server.cleanup());

test("server.fetch alone is unauthenticated → create denied", async () => {
  const res = await server.fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ id: "p0", title: "Nope", authorId: "x" }),
  });
  expect(res.status).toBe(403);
});

test("loginAs seeds a user + session and authenticates create", async () => {
  const alice = await server.loginAs("alice@example.com");
  expect(alice.userId).toBeString();
  expect(alice.sessionId).toBeString();

  const res = await alice.fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ id: "p1", title: "Hello", authorId: alice.userId }),
  });
  expect(res.status).toBe(201);
});

test("loginAs accepts an options object with custom id + role", async () => {
  const admin = await server.loginAs({ id: "admin1", email: "admin@x.com", role: "admin" });
  expect(admin.userId).toBe("admin1");
  const me = await admin.fetch("/auth/me");
  expect(me.status).toBe(200);
  const body = await me.json();
  expect(body.user.id).toBe("admin1");
  expect(body.user.role).toBe("admin");
});
