#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(process.cwd(), process.argv[2] ?? "./dist/bunbase");
const outDir = dirname(output);

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

// Build CLI executable
const buildProc = Bun.spawn(["bun", "build", "--compile", "./src/index.ts", "--outfile", output], {
  stdout: "inherit",
  stderr: "inherit",
});

const buildCode = await buildProc.exited;
if (buildCode !== 0) {
  process.exit(buildCode);
}

console.log(`Built executable at ${output}`);

// Build admin UI (Tailwind CSS + TSX) into dist/admin with stable public path
console.log("Building admin UI...");
const tailwindPlugin = (await import("bun-plugin-tailwind")).default;
const adminBuild = await Bun.build({
  entrypoints: ["./admin-ui/index.html"],
  outdir: "./dist/admin",
  publicPath: "/_admin-assets/",
  plugins: [tailwindPlugin],
  minify: true,
});
if (!adminBuild.success) {
  console.error("Admin UI build failed:", adminBuild.logs);
  process.exit(1);
}
console.log("Admin UI built at ./dist/admin");

// Generate TypeScript declaration files
console.log("Generating type declarations...");
const tscProc = Bun.spawn(["bunx", "tsc", "--project", "tsconfig.emit.json"], {
  stdout: "inherit",
  stderr: "inherit",
});

const tscCode = await tscProc.exited;
if (tscCode !== 0) {
  process.exit(tscCode);
}

console.log("Type declarations generated at ./dist/types");
