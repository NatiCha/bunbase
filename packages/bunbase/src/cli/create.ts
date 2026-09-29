#!/usr/bin/env bun
import { INIT_HELP, parseInitArgs } from "./args.ts";
import { init } from "./init.ts";

const args = process.argv.slice(2);
try {
  if (args.includes("--help") || args.includes("-h")) console.log(INIT_HELP);
  else await init(parseInitArgs(args));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not create project.");
  process.exitCode = 1;
}
