import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const library = join(root, "packages/bunbase");
mkdirSync(join(root, ".cache"), { recursive: true });
const work = mkdtempSync(join(root, ".cache", "container-smoke-"));
const app = join(work, "app");
const id = crypto.randomUUID().slice(0, 8);
const image = `bunbase-workspace-smoke:${id}`;
const dataVolume = `bunbase-smoke-data-${id}`;
const backupVolume = `bunbase-smoke-backup-${id}`;
const restoreVolume = `bunbase-smoke-restore-${id}`;
const serviceKey = `bb_sk_${crypto.randomUUID().replaceAll("-", "")}`;
let container: string | undefined;
let passed = false;
const env = {
  ...process.env,
  PUBLIC_URL: "https://workspace.example.test",
  APP_DOMAIN: "workspace.example.test",
  BUNBASE_SERVICE_KEY: serviceKey,
  BUNBASE_ADMIN_EMAIL: "operator@example.test",
  BUNBASE_ADMIN_PASSWORD: "operator-test-password-123",
};
async function run(command: string[], cwd = app) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${command.slice(0, 3).join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  return stdout.trim();
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function stop() {
  if (!container) return;
  const current = container;
  await run(["docker", "stop", "--time", "20", current]);
  assert(
    (await run(["docker", "inspect", "--format", "{{.State.ExitCode}}", current])) === "0",
    "Container did not shut down cleanly",
  );
  await run(["docker", "rm", current]);
  container = undefined;
}
async function start(restored = false) {
  container = await run([
    "docker",
    "run",
    "--detach",
    "--publish",
    "127.0.0.1::3000",
    "--env",
    "PUBLIC_URL",
    "--env",
    "BUNBASE_SERVICE_KEY",
    "--env",
    "BUNBASE_ADMIN_EMAIL",
    "--env",
    "BUNBASE_ADMIN_PASSWORD",
    "--volume",
    restored ? `${restoreVolume}:/recovery` : `${dataVolume}:/app/data`,
    ...(restored
      ? [
          "--env",
          "BUNBASE_DATA_DIR=/recovery/recovered/data",
          "--env",
          "BUNBASE_MIGRATIONS_DIR=/recovery/recovered/drizzle",
        ]
      : []),
    image,
  ]);
  const binding = await run(["docker", "port", container, "3000/tcp"]);
  const url = `http://${binding}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fetch(`${url}/ready`).catch(() => null))?.ok) {
      const report = JSON.parse(
        await run([
          "docker",
          "exec",
          container,
          "bun",
          "node_modules/@naticha/bunbase/src/cli/index.ts",
          "doctor",
          "--json",
        ]),
      );
      assert(report.status === "pass", "Container diagnostics failed");
      return url;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Container readiness failed: ${await run(["docker", "logs", container])}`);
}
let cookies = "";
async function api(url: string, path: string, body?: unknown) {
  const token =
    cookies
      .split("; ")
      .find((cookie) => cookie.startsWith("csrf_token="))
      ?.split("=")[1] ?? "";
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
      "X-CSRF-Token": decodeURIComponent(token),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookies = set.map((cookie) => cookie.split(";")[0]).join("; ");
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}
try {
  await run(["docker", "info"], root);
  await run(["bun", "pm", "pack", "--destination", work], library);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  assert(tarball, "Missing package archive");
  await run(
    [
      join(library, "dist/bunbase"),
      "init",
      "app",
      "--template",
      "team-workspace",
      "-y",
      "--skip-install",
    ],
    work,
  );
  mkdirSync(join(app, "vendor"));
  await Bun.write(join(app, "vendor/bunbase.tgz"), Bun.file(join(work, tarball)));
  const manifest = await Bun.file(join(app, "package.json")).json();
  manifest.dependencies["@naticha/bunbase"] = "file:./vendor/bunbase.tgz";
  await Bun.write(join(app, "package.json"), JSON.stringify(manifest));
  await run(["bun", "install"]);
  await run(["bun", "run", "db:generate", "--output", "json"]);
  await run(["docker", "compose", "config", "--quiet"]);
  await run(["docker", "build", "--tag", image, "."]);
  let url = await start();
  assert((await fetch(url)).ok, "Production frontend unavailable");
  const credentials = { email: "container-user@example.test", password: "container-password-123" };
  await api(url, "/auth/register", credentials);
  await api(url, "/auth/login", credentials);
  const { organization } = await api(url, "/auth/organizations", { name: "Container team" });
  const record = await api(url, "/api/requests", {
    orgId: organization.id,
    title: "Survives recovery",
  });
  const token =
    cookies
      .split("; ")
      .find((cookie) => cookie.startsWith("csrf_token="))
      ?.split("=")[1] ?? "";
  const form = new FormData();
  form.set("file", new File(["container attachment"], "proposal.txt"));
  const uploaded = await fetch(`${url}/files/requests/${record.id}`, {
    method: "POST",
    headers: { Cookie: cookies, "X-CSRF-Token": decodeURIComponent(token) },
    body: form,
  });
  assert(uploaded.status === 201, "Container upload failed");
  const { file } = await uploaded.json();
  await stop();
  await run([
    "docker",
    "run",
    "--rm",
    "--user",
    "root",
    "--volume",
    `${dataVolume}:/app/data`,
    "--volume",
    `${backupVolume}:/backups`,
    image,
    "bun",
    "run",
    "backup",
    "/backups/snapshot",
    "--stopped",
  ]);
  await run([
    "docker",
    "run",
    "--rm",
    "--user",
    "root",
    "--volume",
    `${backupVolume}:/backups`,
    "--volume",
    `${restoreVolume}:/recovery`,
    image,
    "bun",
    "run",
    "restore",
    "/backups/snapshot",
    "/recovery/recovered",
  ]);
  await run([
    "docker",
    "run",
    "--rm",
    "--user",
    "root",
    "--volume",
    `${restoreVolume}:/recovery`,
    image,
    "chown",
    "-R",
    "bun:bun",
    "/recovery/recovered",
  ]);
  url = await start(true);
  cookies = "";
  await api(url, "/auth/login", credentials);
  assert(
    (await api(url, `/api/requests/${record.id}`)).title === "Survives recovery",
    "Restored request missing",
  );
  assert(
    (await (await fetch(`${url}/files/${file.id}`, { headers: { Cookie: cookies } })).text()) ===
      "container attachment",
    "Restored upload missing",
  );
  await stop();
  passed = true;
  console.log(
    "Container smoke passed: Compose configuration, image build, non-root production startup, readiness, diagnostics, records, uploads, shutdown, and restored login/data/files.",
  );
} finally {
  if (container) await run(["docker", "rm", "--force", container]).catch(() => {});
  for (const volume of [dataVolume, backupVolume, restoreVolume])
    await run(["docker", "volume", "rm", volume], root).catch(() => {});
  await run(["docker", "image", "rm", image], root).catch(() => {});
  if (passed) rmSync(work, { recursive: true, force: true });
  else console.error(`Container smoke artifacts retained: ${work}`);
}
