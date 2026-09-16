import { afterAll, beforeAll, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { BunBaseClientError, createBunBaseClient } from "../client.ts";
import { defineRelations } from "../crud/relations.ts";
import { createTestServer } from "../testing/index.ts";

const owners = sqliteTable("owners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id").notNull(),
  status: text("status").notNull(),
});
const schema = { items, owners };
let server: Awaited<ReturnType<typeof createTestServer>>;

beforeAll(async () => {
  server = await createTestServer({
    schema,
    rules: { items: { list: () => true }, owners: { list: () => true, get: () => true } },
    relations: defineRelations(schema, (r) => ({
      items: { owner: r.one.owners({ from: r.items.ownerId, to: r.owners.id }) },
    })),
  });
  await server.adapter.rawExecute("INSERT INTO owners (id, name) VALUES ('owner', 'Alice')");
  for (let i = 0; i < 235; i++) {
    // Duplicate titles exercise the ID tie-breaker across page boundaries.
    await server.adapter.rawExecute(
      "INSERT INTO items (id, title, owner_id, status) VALUES ($id, $title, 'owner', $status)",
      {
        $id: String(i).padStart(3, "0"),
        $title: `Title ${Math.floor(i / 3)
          .toString()
          .padStart(3, "0")}`,
        $status: i < 200 ? "active" : "archived",
      },
    );
  }
});

afterAll(() => server?.cleanup());

test("SDK listAll traverses more than two real server pages without missing or duplicating rows", async () => {
  const client = createBunBaseClient({ url: server.baseUrl, schema });
  const records = await client.api.items.listAll();
  expect(records.map((row) => row.id)).toEqual(
    Array.from({ length: 235 }, (_, i) => String(i).padStart(3, "0")),
  );
});

test("SDK listAll preserves filters, descending sort ties, and expansions at an exact page boundary", async () => {
  const client = createBunBaseClient({ url: server.baseUrl, schema });
  const records = await client.api.items.listAll({
    filter: { status: "active" },
    sort: "title",
    order: "desc",
    expand: ["owner"],
  });
  expect(records.map((row) => row.id)).toEqual(
    Array.from({ length: 200 }, (_, i) => String(199 - i).padStart(3, "0")),
  );
  for (const row of records) {
    expect(row).toMatchObject({ status: "active", owner: { id: "owner", name: "Alice" } });
  }
});

test("SDK listAll returns an empty collection for no matches", async () => {
  const client = createBunBaseClient({ url: server.baseUrl, schema });
  expect(await client.api.items.listAll({ filter: { status: "missing" } })).toEqual([]);
});

test("SDK listAll preserves query options and bearer auth on every bounded request", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const fixture = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push({ url: req.url, authorization: req.headers.get("authorization") });
      const second = requests.length === 2;
      return Response.json({
        data: [{ id: second ? "two" : "one", title: "Title", ownerId: "owner", status: "active" }],
        hasMore: !second,
        nextCursor: second ? null : "opaque+/=cursor",
      });
    },
  });
  try {
    const client = createBunBaseClient({ url: String(fixture.url), schema, apiKey: "test-key" });
    const records = await client.api.items.listAll({
      filter: { status: "active" },
      sort: "title",
      order: "desc",
      expand: ["owner"],
    });
    expect(records.map((row) => row.id)).toEqual(["one", "two"]);
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      const query = new URL(req.url).searchParams;
      expect(query.get("limit")).toBe("100");
      expect(query.get("filter")).toBe(JSON.stringify({ status: "active" }));
      expect(query.get("sort")).toBe("title");
      expect(query.get("order")).toBe("desc");
      expect(query.get("expand")).toBe("owner");
      expect(req.authorization).toBe("Bearer test-key");
    }
    expect(new URL(requests[1]!.url).searchParams.get("cursor")).toBe("opaque+/=cursor");
  } finally {
    fixture.stop(true);
  }
});

test("SDK listAll rejects a later HTTP failure instead of returning partial records", async () => {
  let calls = 0;
  const fixture = Bun.serve({
    port: 0,
    fetch() {
      if (++calls === 1) {
        return Response.json({ data: [{ id: "one" }], hasMore: true, nextCursor: "next" });
      }
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Access denied" } },
        { status: 403 },
      );
    },
  });
  try {
    const client = createBunBaseClient({ url: String(fixture.url), schema });
    const error = await client.api.items.listAll().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BunBaseClientError);
    expect(error).toMatchObject({ status: 403, code: "FORBIDDEN", message: "Access denied" });
    expect(calls).toBe(2);
  } finally {
    fixture.stop(true);
  }
});

for (const [name, page, message, expectedCalls] of [
  ["missing cursor", { data: [], hasMore: true, nextCursor: null }, "did not advance", 1],
  ["repeated cursor", { data: [], hasMore: true, nextCursor: "same" }, "did not advance", 2],
  ["malformed data", { data: null, hasMore: false }, "Invalid BunBase list response", 1],
] as const) {
  test(`SDK listAll rejects ${name} without looping`, async () => {
    let calls = 0;
    const fixture = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        // Bound requests even against a broken implementation, so the test cannot hang.
        return calls <= 2
          ? Response.json(page)
          : new Response("Too many requests", { status: 500 });
      },
    });
    try {
      const client = createBunBaseClient({ url: String(fixture.url), schema });
      await expect(client.api.items.listAll()).rejects.toThrow(message);
      expect(calls).toBe(expectedCalls);
    } finally {
      fixture.stop(true);
    }
  });
}
