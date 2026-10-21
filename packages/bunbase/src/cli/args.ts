import { parseArgs } from "node:util";
import type { InitOptions } from "./init.ts";
import { DATABASE_OPTIONS, TEMPLATE_OPTIONS } from "./templates.ts";

export const INIT_HELP = `Create a BunBase project:
  bunbase init [name] [--template team-workspace] [--database sqlite] [-y]
  create-bunbase [name] [--template team-workspace] [--database sqlite] [-y]

Options:
  --template       empty, task-manager, blog, saas, inventory, team-workspace
  --database       sqlite, postgres, mysql (team-workspace uses SQLite)
  -y, --yes        Use defaults for unanswered choices
  --skip-install   Generate files only
  --no-start       Install and generate migrations without starting
  -h, --help       Show help`;

export function parseInitArgs(args: string[]): InitOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      template: { type: "string" },
      database: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "skip-install": { type: "boolean" },
      "no-start": { type: "boolean" },
    },
  });
  if (positionals.length > 1) throw new Error("Provide only one project name.");
  const template = TEMPLATE_OPTIONS.find((option) => option.value === values.template)?.value;
  const driver = DATABASE_OPTIONS.find((option) => option.value === values.database)?.value;
  if (values.template && !template) throw new Error("Unknown template. Run bunbase --help.");
  if (values.database && !driver)
    throw new Error("Unknown database. Choose sqlite, postgres, or mysql.");
  return {
    projectName: positionals[0],
    nonInteractive: values.yes,
    skipInstall: values["skip-install"],
    noStart: values["no-start"],
    template,
    driver,
  };
}
