#!/usr/bin/env bun
import { init } from "./init.ts";

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "init": {
    const rest = args.slice(1);
    const nonInteractive = rest.includes("-y") || rest.includes("--yes");
    const projectName = rest.find((a) => !a.startsWith("-"));
    await init({ projectName, nonInteractive });
    break;
  }
  case "--help":
  case "-h":
  case undefined:
    console.log(`
BunBase CLI

Commands:
  init [name]    Create a new BunBase project

Options:
  -y, --yes      Non-interactive mode (defaults: empty template, no OAuth)
  --help, -h     Show this help message

Examples:
  bunbase init              Interactive setup
  bunbase init my-app       Interactive setup with project name
  bunbase init my-app -y    Non-interactive with defaults
`);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run 'bunbase --help' for available commands.");
    process.exit(1);
}
