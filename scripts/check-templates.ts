import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = join(root, "packages/bunbase/src/cli/templates/team-workspace");
const glob = new Bun.Glob("*.{ts,css}.txt");
for await (const file of glob.scan({ cwd: directory, absolute: true })) {
  const child = Bun.spawn(
    ["bunx", "biome", "check", "--write", `--stdin-file-path=${file.slice(0, -4)}`],
    {
      cwd: root,
      stdin: Bun.file(file),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // --write transforms stdin only. Compare the result without changing the source file.
  if (code !== 0 || stdout !== (await Bun.file(file).text())) {
    console.error(`${file}\n${stdout}\n${stderr}`);
    process.exit(1);
  }
}
console.log("Template TypeScript and CSS checks passed.");
