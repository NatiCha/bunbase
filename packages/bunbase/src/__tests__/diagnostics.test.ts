import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../cli/doctor.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import { resolveConfig } from "../core/config.ts";
import { createDiagnostics, dependencyCheck, migrationCheck } from "../core/diagnostics.ts";
import { createServer } from "../core/server.ts";

const root = mkdtempSync(join(tmpdir(), "bunbase-diagnostics-"));
const sqlite = new Database(":memory:");
const adapter = new SqliteAdapter(sqlite);
afterAll(() => {
  sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

test("readiness distinguishes startup, dependency failure, recovery, and shutdown", async () => {
  let state: "starting" | "ready" | "failed" = "starting";
  let available = false;
  const diagnostics = createDiagnostics(
    adapter,
    resolveConfig({ development: true }),
    () => state,
    {
      checks: {
        dependency: () => {
          if (!available) throw new Error("secret connection URL");
        },
      },
    },
  );
  expect((await diagnostics.readiness()).status).toBe("not_ready");
  state = "ready";
  const failed = await diagnostics.readiness();
  expect(failed.status).toBe("not_ready");
  expect(JSON.stringify(failed)).not.toContain("secret");
  available = true;
  expect((await diagnostics.readiness()).status).toBe("ready");
  expect((await diagnostics.readiness(true)).status).toBe("not_ready");
  state = "failed";
  expect((await diagnostics.readiness()).checks[0]?.message).toContain("Startup failed");
});

test("timed-out dependency probes do not accumulate and recover once completed", async () => {
  let calls = 0;
  let finish: () => void = () => {};
  const run = dependencyCheck(
    "slow",
    async () => {
      calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    10,
  );
  expect((await run()).status).toBe("fail");
  expect((await run()).status).toBe("fail");
  expect(calls).toBe(1);
  const next = run();
  finish();
  expect((await next).status).toBe("pass");
});

test("migration report detects pending, changed and missing local migrations", async () => {
  const path = join(root, "migrations");
  const name = "20260928000000_first";
  mkdirSync(join(path, name), { recursive: true });
  const sql = "SELECT 1;";
  writeFileSync(join(path, name, "migration.sql"), sql);
  sqlite.run("CREATE TABLE __drizzle_migrations (name TEXT, hash TEXT)");
  expect((await migrationCheck(adapter, path)).message).toContain("1 pending");
  sqlite
    .query("INSERT INTO __drizzle_migrations VALUES (?, ?)")
    .run(name, createHash("sha256").update(sql).digest("hex"));
  expect((await migrationCheck(adapter, path)).status).toBe("pass");
  writeFileSync(join(path, name, "migration.sql"), "SELECT 2;");
  expect((await migrationCheck(adapter, path)).message).toContain("1 changed");
  sqlite.query("INSERT INTO __drizzle_migrations VALUES (?, ?)").run("absent", "hash");
  expect((await migrationCheck(adapter, path)).message).toContain("1 missing locally");
});

test("readiness HTTP is uncached, sanitized, works with frontend routing, and diagnostics require the service key", async () => {
  const key = `bb_sk_${"1".repeat(32)}`;
  let available = false;
  const app = createServer({
    schema: {},
    config: {
      development: true,
      database: { driver: "sqlite", path: join(root, "server.sqlite") },
      migrationsPath: join(root, "absent-migrations"),
      serviceKey: key,
      frontend: { html: () => new Response("frontend") },
    },
    readiness: {
      checks: {
        dependency: () => {
          if (!available) throw new Error("secret-password");
        },
      },
    },
  });
  const server = app.listen(0);
  try {
    await app.adapter.bootstrapInternalTables();
    await Bun.sleep(10);
    const url = String(server.url);
    const unavailable = await fetch(`${url}ready`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(await unavailable.json()).toEqual({ status: "not_ready" });
    expect((await fetch(`${url}_admin/api/diagnostics`)).status).toBe(401);
    const auth = { headers: { Authorization: `Bearer ${key}` } };
    const report = await (await fetch(`${url}_admin/api/diagnostics`, auth)).json();
    expect(JSON.stringify(report)).not.toContain("secret-password");
    available = true;
    expect((await fetch(`${url}ready`)).status).toBe(200);
    expect((await fetch(`${url}ready`, { method: "POST" })).status).toBe(405);
    expect(await (await fetch(`${url}ready`, { method: "HEAD" })).text()).toBe("");
    const keyFile = join(root, "doctor-key");
    writeFileSync(keyFile, key);
    const previousKey = process.env.BUNBASE_SERVICE_KEY;
    delete process.env.BUNBASE_SERVICE_KEY;
    try {
      const checked = await doctor({ url, keyFile });
      expect(
        checked.checks.some((check) => check.name === "migrations" && check.status === "fail"),
      ).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env.BUNBASE_SERVICE_KEY;
      else process.env.BUNBASE_SERVICE_KEY = previousKey;
    }
    await server.stop(true);
    expect((await app.readiness()).status).toBe("not_ready");
  } finally {
    await server.stop(true);
    await app.adapter.close();
  }
});

test("doctor refuses credential-bearing and nonlocal plaintext URLs", async () => {
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/?token=secret",
    "https://example.com/subpath",
  ]) {
    const report = await doctor({ url });
    expect(report.status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("user:pass");
  }
});

test("failed production startup still serves liveness and protected diagnostics", async () => {
  const key = `bb_sk_${"2".repeat(32)}`;
  const app = createServer({
    schema: {},
    config: {
      development: false,
      cors: { origins: ["https://example.test"] },
      serviceKey: key,
      database: { driver: "sqlite", path: join(root, "failed-start.sqlite") },
      migrationsPath: join(root, "missing-production-migrations"),
      storage: { driver: "local", localPath: root },
    },
  });
  const server = app.listen(0);
  try {
    await Bun.sleep(10);
    expect((await fetch(new URL("health", server.url))).status).toBe(200);
    expect((await fetch(new URL("ready", server.url))).status).toBe(503);
    const response = await fetch(new URL("_admin/api/diagnostics", server.url), {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(503);
    const report = await response.json();
    expect(report.checks[0]).toEqual({
      name: "bootstrap",
      status: "fail",
      message: "Startup failed; inspect server logs.",
    });
    expect(JSON.stringify(report)).not.toContain(root);
  } finally {
    await server.stop(true);
    await app.adapter.close();
  }
});

test("doctor accepts configured key lengths, gives explicit files precedence, and refuses redirects", async () => {
  const key = `bb_sk_${"a".repeat(64)}`;
  const keyFile = join(root, "long-doctor-key");
  writeFileSync(keyFile, key);
  let redirected = false;
  let mode: "report" | "redirect" = "report";
  const target = Bun.serve({
    port: 0,
    fetch: () => {
      redirected = true;
      return new Response("unexpected");
    },
  });
  const source = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (mode === "redirect") return Response.redirect(target.url);
      expect(req.headers.get("authorization")).toBe(`Bearer ${key}`);
      return Response.json({ notes: [], version: "0.2.0", status: "pass", checks: [] });
    },
  });
  const previous = process.env.BUNBASE_SERVICE_KEY;
  process.env.BUNBASE_SERVICE_KEY = "bb_sk_wrong_environment_key";
  try {
    expect((await doctor({ url: String(source.url), keyFile })).status).toBe("pass");
    mode = "redirect";
    expect((await doctor({ url: String(source.url), keyFile })).status).toBe("fail");
    expect(redirected).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.BUNBASE_SERVICE_KEY;
    else process.env.BUNBASE_SERVICE_KEY = previous;
    await source.stop(true);
    await target.stop(true);
  }
});

test("diagnostics rejects a regular file used as the upload directory", async () => {
  const path = join(root, "not-a-directory");
  writeFileSync(path, "");
  const report = await createDiagnostics(
    adapter,
    resolveConfig({ development: true, storage: { localPath: path } }),
    () => "ready",
  ).diagnostics();
  expect(report.checks.find((check) => check.name === "storage")?.status).toBe("fail");
});
