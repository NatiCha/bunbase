import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const library = resolve(import.meta.dir, "../packages/bunbase");
const work = mkdtempSync(join(tmpdir(), "bunbase-production-"));
const live = join(work, "live");
mkdirSync(live);
const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
const origin = `http://localhost:${reservation.port}`;
await reservation.stop(true);
const email = "release@example.com";
const password = "Release-smoke-password-42";
function start(dataDirectory: string) {
  const child = Bun.spawn(["bun", "integration/fixtures/production/server.ts"], {
    cwd: library,
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUNBASE_SMOKE_WORK: dataDirectory,
      BUNBASE_SMOKE_ORIGIN: origin,
      BUNBASE_ADMIN_EMAIL: email,
      BUNBASE_ADMIN_PASSWORD: password,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    process: child,
    output: new Response(child.stdout).text(),
    errors: new Response(child.stderr).text(),
  };
}
let server = start(live);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function waitReady() {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.process.exitCode !== null) throw new Error(await server.errors);
    try {
      ready = (await fetch(`${origin}/health`)).ok;
      if (ready) break;
    } catch {
      // Server is starting.
    }
    await Bun.sleep(50);
  }
  assert(ready, "Production server did not start");
}
try {
  await waitReady();
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (/violat.*Content Security Policy|Refused to/i.test(message.text())) {
      browserErrors.push(message.text());
      console.error(message.text());
    }
  });
  page.on("websocket", (socket) => {
    socket.on("socketerror", (error) => console.error("WebSocket error:", error));
  });

  // Exercise the shipped admin application, including navigation and a deep-link reload.
  const admin = await page.goto(`${origin}/_admin`);
  assert(admin?.headers()["content-security-policy"]);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await page.waitForURL("**/_admin/collections");
  await page.reload();
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  await page.waitForURL("**/_admin/storage");
  const session = (await context.cookies()).find((cookie) => cookie.name === "bunbase_session");
  assert(session?.secure && session.httpOnly, "Production session must be Secure and HttpOnly");

  // Clear the session before signing in through the public SDK with real cookies/CSRF.
  await context.clearCookies();
  const frontend = await page.goto(`${origin}/nested/route`);
  assert(frontend?.headers()["content-security-policy"]);
  const layout = await page.locator("main").evaluate((element) => {
    const style = getComputedStyle(element);
    return { display: style.display, direction: style.flexDirection, padding: style.paddingTop };
  });
  assert.deepEqual(layout, { display: "flex", direction: "column", padding: "32px" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("#auth").filter({ hasText: "Signed in" }).waitFor();
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await page.locator("#connection").filter({ hasText: "ready" }).waitFor();
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.locator("#record").filter({ hasText: /.+/ }).waitFor();
  const recordId = await page.locator("#record").innerText();
  await page
    .locator("#event")
    .filter({ hasText: `INSERT:${recordId}` })
    .waitFor();
  await page.getByLabel("File", { exact: true }).setInputFiles({
    name: "release.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("production upload verified"),
  });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.locator("#uploaded").filter({ hasText: /.+/ }).waitFor();
  const fileId = await page.locator("#uploaded").innerText();
  const downloaded = await context.request.get(`${origin}/files/${fileId}`);
  assert.equal(downloaded.status(), 200);
  assert.equal(await downloaded.text(), "production upload verified");
  assert.equal(await page.locator("#error").innerText(), "");
  assert.deepEqual(browserErrors, []);
  console.log(
    "Passed: production browser login, admin navigation, Tailwind, CSP, CRUD, realtime, and upload/download",
  );

  // Stop every writer, take an offline copy, and restore into a separate directory.
  // Keep the browser's WebSocket open to verify shutdown closes it without hanging.
  server.process.kill("SIGTERM");
  assert.equal(await server.process.exited, 0, await server.errors);
  const backup = join(work, "backup");
  const restored = join(work, "restored");
  cpSync(live, backup, { recursive: true });
  cpSync(backup, restored, { recursive: true });
  const database = new Database(join(restored, "db.sqlite"), { readonly: true });
  try {
    assert.deepEqual(database.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
  } finally {
    database.close();
  }
  server = start(restored);
  await waitReady();
  const login = await context.request.post(`${origin}/auth/login`, { data: { email, password } });
  assert.equal(login.status(), 200);
  const record = await context.request.get(`${origin}/api/tasks/${recordId}`);
  assert.equal(record.status(), 200);
  assert.equal((await record.json()).title, "Production browser task");
  const restoredFile = await context.request.get(`${origin}/files/${fileId}`);
  assert.equal(restoredFile.status(), 200);
  assert.equal(await restoredFile.text(), "production upload verified");
  console.log(
    "Passed: offline SQLite/upload backup, isolated restore, integrity, login, record, and file",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.process.kill("SIGTERM");
  const exit = await server.process.exited;
  if (exit !== 0) {
    console.error(
      `Production server exited ${exit}\n${await server.output}\n${await server.errors}`,
    );
    process.exitCode = 1;
  }
  rmSync(work, { recursive: true, force: true });
}
