import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const library = join(root, "packages/bunbase");
const cache = join(root, ".cache");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "scaffold-smoke-"));
const app = join(work, "app");
let server: ReturnType<typeof Bun.spawn> | undefined;
let passed = false;

async function run(command: string[], cwd: string) {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  console.log(`Passed: ${command.join(" ")}`);
  return stdout;
}

try {
  await run(["bun", "pm", "pack", "--destination", work], library);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("Package archive was not created");
  const cli = join(library, "dist/bunbase");
  await run([cli, "--help"], work);
  await run([cli, "init", "app", "-y", "--skip-install"], work);
  const manifestPath = join(app, "package.json");
  const manifest = await Bun.file(manifestPath).json();
  manifest.dependencies["@naticha/bunbase"] = `file:${join(work, tarball)}`;
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await run(["bun", "install"], app);
  // The optional passkey provider must not be required by ordinary consumers.
  await run(["bun", "run", "type"], app);
  await run(["bun", "test"], app);
  await run(["bun", "run", "db:generate"], app);

  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const url = `http://localhost:${port}`;
  const started = Bun.spawn(["bun", "src/index.ts"], {
    cwd: app,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  server = started;
  const output = new Response(started.stdout).text();
  const errors = new Response(started.stderr).text();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error(`Generated server exited\n${await output}\n${await errors}`);
    try {
      ready = (await fetch(`${url}/health`)).ok;
      if (ready) break;
    } catch {
      /* server is starting */
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Generated server did not become healthy");
  const csrf = "scaffold-smoke";
  const res = await fetch(`${url}/auth/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `csrf_token=${csrf}`,
      "x-csrf-token": csrf,
    },
    body: JSON.stringify({ email: "smoke@example.com", password: "Smoke-test-password-42" }),
  });
  if (res.status !== 201) throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  const registration = await res.json();
  if (!registration.user?.id) throw new Error("Registration did not return a user");
  const admin = await fetch(`${url}/_admin`);
  const html = await admin.text();
  if (!admin.ok || !html.includes("/_admin-assets/")) throw new Error("Packed admin UI is missing");
  const assets = [...html.matchAll(/(?:src|href)="(\/_admin-assets\/[^"?#]+)/g)];
  if (assets.length === 0) throw new Error("No admin assets found");
  for (const [, asset] of assets) {
    if (!(await fetch(`${url}${asset}`)).ok) throw new Error(`Missing packed asset: ${asset}`);
  }
  console.log(
    "Passed: installed scaffold typecheck, tests, generated migrations, server startup, registration, and admin assets",
  );
  passed = true;
} finally {
  if (server) {
    server.kill();
    await server.exited;
  }
  if (passed) rmSync(work, { recursive: true, force: true });
  else console.error(`Smoke-test files retained at ${work}`);
}
