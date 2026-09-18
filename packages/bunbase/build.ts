#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(import.meta.dir, process.argv[2] ?? "dist/bunbase");
mkdirSync(dirname(output), { recursive: true });

async function run(command: string[]) {
  const proc = Bun.spawn(command, {
    cwd: import.meta.dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

await run(["bun", "run", "build-admin.ts"]);
await run(["bun", "build", "--compile", "src/cli/index.ts", "--outfile", output]);
await run(["bun", "run", "tsc", "--project", "tsconfig.emit.json"]);
console.log(`Built CLI at ${output} and declarations at dist/types`);
