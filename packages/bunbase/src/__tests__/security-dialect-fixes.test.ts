import { expect, spyOn, test } from "bun:test";
import { drizzle as mysqlDrizzle } from "drizzle-orm/bun-sql/mysql";
import { drizzle as pgDrizzle } from "drizzle-orm/bun-sql/postgres";
import { mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { consumeRefreshJwt, revokeUserJwts, signJwt, verifyJwt } from "../auth/jwt/core.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { generateCrudHandlers } from "../crud/handler.ts";

// Exercise the installed driver/query builders with a controlled wire boundary;
// no live database URL is needed and no select can hide a failed INSERT.
for (const generated of [false, true]) {
  test(`MySQL CRUD executes INSERT before retrieval (${generated ? "defaultFn" : "supplied"} ID)`, async () => {
    const table = mysqlTable("items", {
      id: generated
        ? varchar("id", { length: 80 })
            .primaryKey()
            .$defaultFn(() => "generated-id")
        : varchar("id", { length: 80 }).primaryKey(),
      title: varchar("title", { length: 80 }).notNull(),
    });
    const calls: string[] = [];
    let fail = false;
    let saved: unknown[] = [];
    const client = {
      options: {},
      unsafe(query: string, params: unknown[]) {
        calls.push(query);
        if (query.startsWith("insert")) {
          if (fail) return Promise.reject(new Error("duplicate primary key"));
          saved = params;
          return Promise.resolve({ lastInsertRowid: 0, affectedRows: 1 });
        }
        return { values: async () => [saved] };
      },
    };
    const db = mysqlDrizzle({ client: client as any });
    const { exact } = generateCrudHandlers(table, db, async () => null, { create: () => true });
    const request = () =>
      new Request("http://localhost/api/items", {
        method: "POST",
        body: JSON.stringify({ ...(generated ? {} : { id: "supplied-id" }), title: "created" }),
      });
    const response = await exact["/api/items"]!.POST!(request());
    expect(response.status).toBe(201);
    expect((await response.json()).id).toBe(generated ? "generated-id" : "supplied-id");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toStartWith("insert");
    expect(calls[1]).toStartWith("select");
    fail = true;
    calls.length = 0;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await exact["/api/items"]!.POST!(request())).status).toBe(500);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toStartWith("insert");
    } finally {
      error.mockRestore();
    }
  });
}

for (const dialect of ["postgres", "mysql"] as const) {
  test(`${dialect} JWT cutoff uses atomic monotonic upsert through installed driver`, async () => {
    let query = "";
    let params: unknown[] = [];
    const client = {
      options: {},
      unsafe(sql: string, values: unknown[]) {
        query = sql;
        params = values;
        return Promise.resolve([]);
      },
    };
    const db =
      dialect === "mysql"
        ? mysqlDrizzle({ client: client as any })
        : pgDrizzle({ client: client as any });
    await revokeUserJwts(db, getInternalSchema(dialect), "user-id");
    expect(query).toContain(dialect === "mysql" ? "on duplicate key update" : "on conflict");
    expect(query).toContain("CASE WHEN");
    expect(query).toContain("created_at");
    expect(params).toContain(Number.MAX_SAFE_INTEGER);
  });
}

test("Bun PostgreSQL SQLSTATE in errno revokes a replayed refresh family idempotently", async () => {
  const calls: unknown[][] = [];
  const client = {
    options: {},
    unsafe(_query: string, params: unknown[]) {
      calls.push(params);
      // Bun exposes PostgreSQL SQLSTATE on errno; Drizzle wraps this as cause.
      return Promise.reject(
        Object.assign(new Error("duplicate key"), {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "23505",
        }),
      );
    },
  };
  const db = pgDrizzle({ client: client as any });
  const secret = "postgres-replay-test";
  const token = await signJwt(
    { sub: "user", email: "user@example.com", role: "user", type: "refresh" },
    secret,
    60,
  );
  const payload = (await verifyJwt(token, secret))!;
  expect(await consumeRefreshJwt(db, getInternalSchema("postgres"), payload)).toBe(false);
  expect(calls).toHaveLength(2);
  expect(String(calls[0]![0])).toStartWith("refresh:");
  expect(String(calls[1]![0])).toStartWith("family:");
});
