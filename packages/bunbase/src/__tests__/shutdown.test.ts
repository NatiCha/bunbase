import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainServer } from "../core/shutdown.ts";

test("shutdown waits for requests and jobs before closing the database", async () => {
  const requests = Promise.withResolvers<void>();
  const jobs = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const calls: string[] = [];
  const drained = drainServer({
    stop: async () => {
      calls.push("stop");
      await requests.promise;
    },
    idle: () => jobs.promise,
    close: async () => {
      calls.push("close");
      await closing.promise;
    },
  });
  requests.resolve();
  await Bun.sleep(5);
  expect(calls).toEqual(["stop"]);
  jobs.resolve();
  await Bun.sleep(5);
  expect(calls).toEqual(["stop", "close"]);
  closing.resolve();
  await drained;
});

test("shutdown forces connections closed at the deadline without closing a busy database", async () => {
  const calls: boolean[] = [];
  let closed = false;
  await expect(
    drainServer(
      {
        stop: async (force = false) => {
          calls.push(force);
          if (!force) await new Promise(() => {});
        },
        idle: async () => {},
        close: () => {
          closed = true;
        },
      },
      20,
    ),
  ).rejects.toThrow("shutdown exceeded");
  expect(calls).toEqual([false, true]);
  expect(closed).toBe(false);
});

test("SIGTERM drains a real HTTP request that still needs its database", async () => {
  const work = mkdtempSync(join(tmpdir(), "bunbase-shutdown-"));
  const ready = join(work, "ready");
  const started = join(work, "started");
  const entry = join(work, "server.ts");
  const module = new URL("../index.ts", import.meta.url).pathname;
  await Bun.write(
    entry,
    `import { createServer } from ${JSON.stringify(module)};
const app = createServer({ schema: {}, rules: {}, config: {
  development: true, serviceKey: "shutdown-test-only",
  dbPath: ${JSON.stringify(join(work, "db.sqlite"))},
  migrationsPath: ${JSON.stringify(join(work, "migrations"))}
}, extend: () => ({ "/api/slow": { GET: async () => {
  await Bun.write(${JSON.stringify(started)}, "started");
  await Bun.sleep(150);
  await app.adapter.rawQuery("SELECT 1");
  return new Response("completed");
} } }) });
const server = app.listen(0);
await Bun.write(${JSON.stringify(ready)}, String(server.url));`,
  );
  const child = Bun.spawn([process.execPath, entry], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  async function waitFor(path: string) {
    for (let i = 0; i < 100; i++) {
      if (await Bun.file(path).exists()) return;
      if (child.exitCode !== null) throw new Error(await errors);
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${path}`);
  }
  try {
    await waitFor(ready);
    const url = await Bun.file(ready).text();
    const response = fetch(new URL("/api/slow", url)).then((res) => res.text());
    await waitFor(started);
    child.kill("SIGTERM");
    expect(await response).toBe("completed");
    expect(await child.exited).toBe(0);
    expect(await output).toContain("Shutting down");
    expect(await errors).not.toContain("Shutdown failed");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    rmSync(work, { recursive: true, force: true });
  }
});
