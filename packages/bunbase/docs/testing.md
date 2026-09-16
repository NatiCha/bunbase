---
title: Testing
---

BunBase ships a `@naticha/bunbase/testing` subpath with a `createTestServer` helper that spins up a real server in-process for integration tests. It handles all the boilerplate: creates a temp SQLite database, bootstraps internal tables, starts the server on a random port, and manages CSRF tokens automatically.

## Setup

```ts
import { createTestServer } from "@naticha/bunbase/testing";
import { test, expect, afterAll } from "bun:test";
import * as schema from "../src/schema";
import { rules } from "../src/rules";

const server = await createTestServer({ schema, rules });
afterAll(() => server.cleanup());
```

Run tests with:

```bash
bun test
```

## `createTestServer`

```ts
createTestServer(options: CreateTestServerOptions): Promise<TestServer>

interface CreateTestServerOptions {
  schema: Record<string, unknown>;   // your Drizzle table definitions
  rules?: Rules;                     // access control rules
  hooks?: Hooks;                     // lifecycle hooks
  relations?: unknown;               // from defineRelations (enables ?expand=)
}
```

Returns a `TestServer` object (see below). Always call `server.cleanup()` in `afterAll` to stop the server and delete temp files.

## `TestServer`

```ts
interface TestServer {
  baseUrl: string;                                          // e.g. "http://localhost:54321"
  fetch(path: string, init?: RequestInit): Promise<Response>;
  db: AnyDb;                                               // Drizzle db instance
  adapter: DatabaseAdapter;                                // raw adapter
  cleanup(): void;
}
```

### `server.fetch`

Like `globalThis.fetch` but with:
- `baseUrl` prepended automatically
- `X-CSRF-Token` and `cookie: csrf_token=...` headers set on every request
- `Content-Type: application/json` defaulted when not provided

```ts
const res = await server.fetch("/api/posts", {
  method: "POST",
  body: JSON.stringify({ title: "Hello" }),
});
expect(res.status).toBe(201);
```

### `server.db`

The Drizzle database instance. Use it for direct queries in your test assertions:

```ts
import { eq } from "drizzle-orm";
import { posts } from "../src/schema";

test("creates post", async () => {
  await server.fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ title: "My Post" }),
  });

  const rows = await server.db.select().from(posts).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.title).toBe("My Post");
});
```

### `server.adapter.rawExecute`

Run raw SQL — useful for seeding test data:

```ts
await server.adapter.rawExecute(
  `INSERT INTO posts (id, title) VALUES ('p1', 'Seeded Post')`
);
```

## Testing authenticated routes

`server.fetch` has no cookie jar, so it is always unauthenticated. To act as a
logged-in user, use `server.loginAs(...)` — it seeds the user and a session row
directly and returns a `fetch` bound to that session cookie (plus CSRF):

```ts
test("owner can update their post", async () => {
  const alice = await server.loginAs({ email: "alice@example.com", role: "user" });

  // Create a post as Alice (her session cookie is sent automatically)
  const createRes = await alice.fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ title: "Alice's Post" }),
  });
  const post = await createRes.json();

  const updateRes = await alice.fetch(`/api/posts/${post.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: "Updated" }),
  });
  expect(updateRes.status).toBe(200);
});
```

`loginAs` returns `{ userId, sessionId, fetch }`. Pass an email string or an
object with `email`/`role`/`id`/`columns`. (It's SQLite-focused, matching
`createTestServer`.) You can still seed users and sessions manually with
`server.adapter.rawExecute(...)` if you prefer.

## Example: full CRUD test suite

```ts
import { createTestServer } from "@naticha/bunbase/testing";
import { test, expect, afterAll } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineRules } from "@naticha/bunbase";

const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id").notNull(),
});

const rules = defineRules({
  posts: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => auth !== null,
    update: ({ auth }) => auth !== null,
    delete: ({ auth }) => auth?.role === "admin",
  },
});

const server = await createTestServer({ schema: { posts }, rules });
afterAll(() => server.cleanup());

test("unauthenticated list returns empty array", async () => {
  const res = await server.fetch("/api/posts");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toEqual([]);
});

test("create requires auth", async () => {
  // Not logged in — no session cookie
  const res = await server.fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ title: "Hello", authorId: "user-1" }),
  });
  expect(res.status).toBe(403);
});
```

## Notes

- Tests run against SQLite in a temp directory — no external database required.
- `development: true` is always set, so CORS is open and cookies have no `Secure` flag.
- Each `createTestServer` call creates an isolated database. Parallel test files are safe.
- The server starts on port `0`, so the OS assigns a free port — no port conflicts between test files.

## BunBase database regression suite

When contributing to BunBase, run `bun run test` from the repository root. Alongside
the main tests, it runs seven SQLite database/SDK regressions in a separate process
so the migration-error unit tests' module mocks cannot replace the real migrator.

The same seven scenarios run against PostgreSQL when `BUNBASE_TEST_POSTGRES_URL`
is set. From the repository root:

```sh
BUNBASE_TEST_POSTGRES_URL="postgresql://user:password@localhost:5432/bunbase_test" bun run test:databases
```

Use a disposable database. The suite bootstraps internal tables and applies real
generated migrations; it does not erase migration history or internal tables when
finished. Each fixture uses unique user-table names and removes its user tables.
SQLite uses temporary files that are removed automatically. Without a PostgreSQL
URL, PostgreSQL cases report skips; SQLite still runs. Leave
`BUNBASE_TEST_MYSQL_URL` unset to skip the separate MySQL smoke test.

Coverage includes timestamp/JSON/boolean/null round-trips, SDK CRUD over HTTP,
205 matching records across cursor pages with duplicate sort values, optional and
to-many relations, denied/filtered relationship access, and adding a defaulted
column while preserving existing rows and safely rerunning the migration.
