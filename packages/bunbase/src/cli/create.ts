#!/usr/bin/env bun
// Entry point for the installed `create-bunbase` command.
import { init } from "./init.ts";

const args = process.argv.slice(2);
const nonInteractive = args.includes("-y") || args.includes("--yes");
const projectName = args.find((a) => !a.startsWith("-"));

await init({
  projectName,
  nonInteractive,
  skipInstall: args.includes("--skip-install"),
  noStart: args.includes("--no-start"),
});
