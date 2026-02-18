#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(process.cwd(), process.argv[2] ?? "./dist/tsbase");
const outDir = dirname(output);

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const proc = Bun.spawn([
  "bun",
  "build",
  "--compile",
  "./src/index.ts",
  "--outfile",
  output,
], {
  stdout: "inherit",
  stderr: "inherit",
});

const code = await proc.exited;
if (code !== 0) {
  process.exit(code);
}

console.log(`Built executable at ${output}`);
