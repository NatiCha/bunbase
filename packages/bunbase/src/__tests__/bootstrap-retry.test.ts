import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { createServer } from "../core/server.ts";

const root = mkdtempSync(join(tmpdir(), "bunbase-bootstrap-retry-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a failed startup retries and serves once it succeeds, without a restart", async () => {
  const real = SqliteAdapter.prototype.bootstrapInternalTables;
  let calls = 0;
  const spy = spyOn(SqliteAdapter.prototype, "bootstrapInternalTables").mockImplementation(
    async function (this: SqliteAdapter) {
      calls++;
      if (calls <= 2) throw new Error("canceling statement due to lock timeout");
      return real.call(this);
    },
  );
  const errors = spyOn(console, "error").mockImplementation(() => {});

  const app = createServer({
    schema: {},
    config: {
      development: true,
      database: { driver: "sqlite", path: join(root, "retry.sqlite") },
      migrationsPath: join(root, "absent-migrations"),
    },
  });
  const server = app.listen(0);
  try {
    await Bun.sleep(20);
    const starting = await fetch(new URL("api/nothing-here", server.url));
    expect(starting.status).toBe(503);
    expect(starting.headers.get("retry-after")).toBe("5");
    expect((await starting.json()).error.code).toBe("STARTING");
    expect((await fetch(new URL("ready", server.url))).status).toBe(503);
    expect((await fetch(new URL("health", server.url))).status).toBe(200);

    // Retries after 1s, then 2s; the third attempt succeeds.
    const deadline = Date.now() + 8000;
    while ((await fetch(new URL("ready", server.url))).status !== 200) {
      if (Date.now() > deadline) throw new Error("server never became ready");
      await Bun.sleep(100);
    }
    expect(calls).toBe(3);
    expect((await fetch(new URL("api/nothing-here", server.url))).status).not.toBe(503);
    expect(errors.mock.calls[0]?.[0]).toContain("Startup failed (attempt 1); retrying in 1s");
  } finally {
    spy.mockRestore();
    errors.mockRestore();
    await server.stop(true);
    await app.adapter.close();
  }
}, 15_000);

test("stopping the server ends a startup that keeps failing", async () => {
  let calls = 0;
  const spy = spyOn(SqliteAdapter.prototype, "bootstrapInternalTables").mockImplementation(
    async () => {
      calls++;
      throw new Error("still locked");
    },
  );
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const app = createServer({
    schema: {},
    config: {
      development: true,
      database: { driver: "sqlite", path: join(root, "stuck.sqlite") },
      migrationsPath: join(root, "absent-migrations"),
    },
  });
  const server = app.listen(0);
  try {
    await Bun.sleep(20);
    expect((await fetch(new URL("api/x", server.url))).status).toBe(503);
    await server.stop(true);
    // One attempt, then stop() woke the backoff and the loop ended: no retry
    // fires after the 1s delay would have passed.
    await Bun.sleep(1500);
    expect(calls).toBe(1);
  } finally {
    await server.stop(true);
    spy.mockRestore();
    errors.mockRestore();
    await app.adapter.close();
  }
});
