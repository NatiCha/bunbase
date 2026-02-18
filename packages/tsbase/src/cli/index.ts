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
TSBase CLI

Commands:
  init [name]    Create a new TSBase project

Options:
  -y, --yes      Non-interactive mode (defaults: empty template, no OAuth)
  --help, -h     Show this help message

Examples:
  tsbase init              Interactive setup
  tsbase init my-app       Interactive setup with project name
  tsbase init my-app -y    Non-interactive with defaults
`);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run 'tsbase --help' for available commands.");
    process.exit(1);
}
