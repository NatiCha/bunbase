import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, "..");
const library = join(root, "packages/bunbase");
const cache = join(root, ".cache");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "workspace-smoke-"));
const app = join(work, "app");
let process: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let passed = false;
const failures: string[] = [];
const serviceKey = `bb_sk_${crypto.randomUUID().replaceAll("-", "")}`;

async function run(command: string[], cwd = app) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, BUNBASE_SERVICE_KEY: serviceKey },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  console.log(`Passed: ${command.join(" ")}`);
  return stdout;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function stop() {
  if (!process) return;
  process.kill("SIGTERM");
  const code = await process.exited;
  process = undefined;
  assert(code === 0, `Server shutdown failed (${code})`);
}
async function start(data = join(app, "data"), migrations = join(app, "drizzle")) {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const url = `http://localhost:${port}`;
  const log = Bun.file(join(work, `server-${port}.log`));
  process = Bun.spawn(["bun", "run", "start"], {
    cwd: app,
    stdout: log,
    stderr: log,
    env: {
      ...globalThis.process.env,
      NODE_ENV: "production",
      PORT: String(port),
      PUBLIC_URL: "https://workspace.example.test",
      BUNBASE_SERVICE_KEY: serviceKey,
      BUNBASE_ADMIN_EMAIL: "operator@example.test",
      BUNBASE_ADMIN_PASSWORD: "operator-test-password-123",
      BUNBASE_DATA_DIR: data,
      BUNBASE_MIGRATIONS_DIR: migrations,
    },
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error(`Server exited: ${await log.text()}`);
    const response = await fetch(`${url}/ready`).catch(() => null);
    if (response?.ok) return url;
    await Bun.sleep(100);
  }
  throw new Error(`Readiness failed: ${await log.text()}`);
}

try {
  await run(["bun", "pm", "pack", "--destination", work], library);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  assert(tarball, "No package archive");
  const cli = join(library, "dist/bunbase");
  await run([cli, "init", "app", "--template", "team-workspace", "-y", "--skip-install"], work);
  mkdirSync(join(app, "vendor"));
  await Bun.write(join(app, "vendor", "bunbase.tgz"), Bun.file(join(work, tarball)));
  const manifest = await Bun.file(join(app, "package.json")).json();
  manifest.dependencies["@naticha/bunbase"] = "file:./vendor/bunbase.tgz";
  await Bun.write(join(app, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await run(["bun", "install"]);
  await run(["bun", "run", "type"]);
  await run(["bun", "test"]);
  await run(["bun", "run", "db:generate", "--output", "json"]);
  const installedCli = join(app, "node_modules/@naticha/bunbase/src/cli/index.ts");
  await run(
    [
      "bun",
      join(app, "node_modules/@naticha/bunbase/src/cli/create.ts"),
      "second",
      "--template",
      "team-workspace",
      "-y",
      "--skip-install",
    ],
    work,
  );
  let url = await start();
  const report = JSON.parse(await run(["bun", installedCli, "doctor", "--url", url, "--json"]));
  assert(
    report.checks.some(
      (check: { name: string; status: string }) =>
        check.name === "migrations" && check.status === "pass",
    ),
    "Doctor must verify applied migrations",
  );
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(url);
  await page.getByRole("button", { name: "New here? Create an account" }).click();
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("workspace-password-123");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByText("A fresh start for your team").waitFor();
  await page.getByText("Create a workspace", { exact: true }).click();
  await page.getByLabel("Workspace name", { exact: true }).fill("Acme Studio");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Approve the September proposal");
  await page
    .getByLabel("Details", { exact: true })
    .fill("Review the attached scope and approve the next phase.");
  await page.getByRole("button", { name: "Create request", exact: true }).click();
  await page.getByRole("button", { name: /Approve the September proposal/ }).click();
  await page.getByLabel("Add an attachment").setInputFiles({
    name: "proposal.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Private proposal attachment"),
  });
  await page.getByRole("button", { name: "Upload attachment" }).click();
  const attachment = page.getByRole("link", { name: /proposal.txt/ });
  await attachment.waitFor();
  const attachmentPath = new URL((await attachment.getAttribute("href"))!).pathname;
  assert(
    (await (await context.request.get(`${url}${attachmentPath}`)).text()) ===
      "Private proposal attachment",
    "Uploaded contents must match",
  );
  await page.getByText("Invite a teammate", { exact: true }).click();
  await page.getByLabel("Teammate email").fill("member@example.test");
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.locator("#invite-result").waitFor({ state: "visible" });
  const token = await page.locator("#invite-token").inputValue();
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  member.on("pageerror", (error) => failures.push(error.message));
  await member.goto(url);
  await member.getByRole("button", { name: "New here? Create an account" }).click();
  await member.getByLabel("Email", { exact: true }).fill("member@example.test");
  await member.getByLabel("Password", { exact: true }).fill("workspace-password-123");
  await member.getByRole("button", { name: "Create account", exact: true }).click();
  await member.getByText("A fresh start for your team").waitFor();
  assert(
    (await memberContext.request.get(`${url}${attachmentPath}`)).status() === 403,
    "Nonmember cannot download attachment",
  );
  await member.getByText("Join a workspace", { exact: true }).click();
  await member.locator("#join-form input").fill(token);
  await member.getByRole("button", { name: "Accept invitation" }).click();
  await member.getByRole("button", { name: /Approve the September proposal/ }).click();
  assert(await member.locator("#approve-request").isHidden(), "Members cannot approve requests");
  await page.getByRole("button", { name: "Approve request", exact: true }).click();
  await page.getByRole("button", { name: /Approve the September proposal.*Approved/ }).waitFor();
  await page.screenshot({ path: join(work, "workspace-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(work, "workspace-mobile.png"), fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Mobile layout must not overflow horizontally",
  );
  assert(failures.length === 0, `Browser errors: ${failures.join(", ")}`);
  await context.close();
  await memberContext.close();
  await stop();
  const backup = join(work, "backup");
  const restored = join(work, "restored");
  await run(["bun", installedCli, "backup", backup, "--stopped"]);
  await run(["bun", installedCli, "backup", "verify", backup]);
  await run(["bun", installedCli, "restore", backup, restored]);
  url = await start(join(restored, "data"), join(restored, "drizzle"));
  await run(["bun", installedCli, "doctor", "--url", url, "--json"]);
  const restoreContext = await browser.newContext();
  const restorePage = await restoreContext.newPage();
  await restorePage.goto(url);
  await restorePage.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await restorePage.getByLabel("Password", { exact: true }).fill("workspace-password-123");
  await restorePage.getByRole("button", { name: "Sign in", exact: true }).click();
  await restorePage
    .getByRole("button", { name: /Approve the September proposal.*Approved/ })
    .waitFor();
  assert(
    (await (await restoreContext.request.get(`${url}${attachmentPath}`)).text()) ===
      "Private proposal attachment",
    "Restored attachment must be readable after login",
  );
  await restoreContext.close();
  await stop();
  passed = true;
  console.log(
    `Workspace smoke passed: installed package, tenant tests, production UI, invitations, attachments, approval, diagnostics, and restored login/data/files. Artifacts: ${work}`,
  );
} finally {
  await browser?.close();
  if (process) {
    process.kill("SIGTERM");
    await process.exited;
  }
  // Retain screenshots and failed fixtures for inspection; successful apps/data can be large.
  if (passed && globalThis.process.env.BUNBASE_KEEP_SMOKE !== "1") {
    for (const name of ["app", "second", "backup", "restored"])
      rmSync(join(work, name), { recursive: true, force: true });
  }
  if (!passed) console.error(`Workspace smoke artifacts retained: ${work}`);
}
