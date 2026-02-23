import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { clack, closePrompts, multiSelect, select, text } from "./prompts.ts";
import { printSummary } from "./summary.ts";
import {
  AGENTS_MD,
  CLAUDE_MD,
  DATABASE_OPTIONS,
  type DatabaseDriver,
  getTemplate,
  OAUTH_OPTIONS,
  type OAuthProvider,
  slugifyDbName,
  TEMPLATE_OPTIONS,
  type TemplateType,
} from "./templates.ts";

const STATIC_FILES: Record<string, string> = {
  "tsconfig.json": `{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "exclude": ["dist", "node_modules"]
}
`,

  "bunfig.toml": `[serve.static]
plugins = ["bun-plugin-tailwind"]
`,

  ".gitignore": `node_modules
dist
data/
.env
.env.local
.DS_Store
*.tsbuildinfo
`,
};

export interface InitOptions {
  projectName?: string;
  nonInteractive?: boolean;
}

export async function init({ projectName, nonInteractive }: InitOptions) {
  clack.intro("\x1b[1m\x1b[36mBunBase\x1b[0m — create a new project");

  // 1. Get project name
  if (!projectName) {
    if (nonInteractive) {
      console.error("Error: project name is required with -y/--yes flag.");
      process.exit(1);
    }
    projectName = await text("Project name", "my-app");
    if (!projectName) {
      console.error("Error: project name is required.");
      process.exit(1);
    }
  }

  // 2. Check directory doesn't exist
  const projectDir = join(process.cwd(), projectName);
  if (existsSync(projectDir)) {
    console.error(`\n  Error: Directory "${projectName}" already exists.\n`);
    process.exit(1);
  }

  // 3. Select database driver
  let driver: DatabaseDriver = "sqlite";
  if (!nonInteractive) {
    driver = await select("Database", DATABASE_OPTIONS);
  }

  // 4. For Postgres/MySQL: prompt for database name (default derived from project name)
  let dbName = slugifyDbName(projectName);
  if (driver !== "sqlite" && !nonInteractive) {
    const input = await text("Database name", dbName);
    if (input) dbName = slugifyDbName(input);
  }

  // 5. Select template
  let templateType: TemplateType = "empty";
  if (!nonInteractive) {
    templateType = await select("What are you building?", TEMPLATE_OPTIONS);
  }

  // 6. Select OAuth providers
  let oauthProviders: OAuthProvider[] = [];
  if (!nonInteractive) {
    oauthProviders = await multiSelect(
      "OAuth providers? (Space to select, Enter to skip)",
      OAUTH_OPTIONS,
    );
  }

  // Done with prompts
  closePrompts();

  // 7. Generate template
  const template = getTemplate(templateType, driver, oauthProviders, dbName);

  // Create directories
  mkdirSync(join(projectDir, "src"), { recursive: true });

  // Write template files
  const files: Record<string, string> = {
    "src/index.ts": template.indexTs,
    "src/schema.ts": template.schema,
    "src/rules.ts": template.rules,
    "drizzle.config.ts": template.drizzleConfig,
    ".env": template.env,
    "CLAUDE.md": CLAUDE_MD,
    "AGENTS.md": AGENTS_MD,
    ...STATIC_FILES,
  };

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(projectDir, filePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await Bun.write(fullPath, content);
  }

  // Write package.json
  const packageJson = {
    name: projectName,
    version: "0.0.1",
    type: "module",
    scripts: {
      dev: "bun --hot src/index.ts",
      start: "NODE_ENV=production bun src/index.ts",
      "db:push": "bunx --bun drizzle-kit push --force",
      "db:generate": "bunx drizzle-kit generate",
      studio: "bunx drizzle-kit studio",
    },
    dependencies: {
      bunbase: resolveBunBaseVersion(projectDir),
      "drizzle-orm": "beta",
    },
    devDependencies: {
      "@types/bun": "latest",
      "bun-plugin-tailwind": "latest",
      "drizzle-kit": "beta",
    },
  };

  await Bun.write(join(projectDir, "package.json"), JSON.stringify(packageJson, null, 2));

  const allFiles = [...Object.keys(files), "package.json"];
  clack.log.info(`Created files:\n${allFiles.map((f) => `  \x1b[2m${f}\x1b[0m`).join("\n")}`);

  // 7. Auto-install
  const installSpinner = clack.spinner();
  installSpinner.start("Installing dependencies");
  try {
    await Bun.$`cd ${projectDir} && bun install`.quiet();
    installSpinner.stop("Dependencies installed");
  } catch (_err) {
    installSpinner.stop("Failed to install dependencies");
    clack.log.error(`Run \x1b[1mcd ${projectName} && bun install\x1b[0m manually.`);
    process.exit(1);
  }

  const migrateSpinner = clack.spinner();
  migrateSpinner.start("Generating initial migration");
  try {
    await Bun.$`cd ${projectDir} && bunx drizzle-kit generate --name init`.quiet();
    migrateSpinner.stop("Initial migration created");
  } catch {
    migrateSpinner.stop("Could not generate migration (run db:generate manually)");
  }

  const port = 3000;

  // 8. Auto-start dev server (both SQLite and Postgres)
  const serverSpinner = clack.spinner();
  serverSpinner.start("Starting dev server");

  const serverProc = Bun.spawn(["bun", "--hot", "src/index.ts"], {
    cwd: projectDir,
    stdout: "inherit",
    stderr: "inherit",
  });

  // Wait for server to be ready
  const ready = await waitForServer(serverProc, port);

  if (!ready && serverProc.exitCode !== null) {
    serverSpinner.stop("Server failed to start");
    clack.log.error(`Try running manually: cd ${projectName} && bun --hot src/index.ts`);
    process.exit(1);
  }

  serverSpinner.stop(ready ? "Server started" : "Server is taking longer than expected...");

  printSummary({
    projectName,
    tables: template.tables,
    oauth: oauthProviders,
    port,
  });

  // Offer to open admin UI
  if (!nonInteractive) {
    const openAdmin = await clack.confirm({
      message: "Open admin UI in browser?",
      initialValue: true,
    });
    if (!clack.isCancel(openAdmin) && openAdmin) {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      Bun.spawn([cmd, `http://localhost:${port}/_admin`]);
    }
  }

  clack.outro("Press Ctrl+C to stop the server.");

  // Keep process alive until server exits or Ctrl+C
  process.on("SIGINT", () => {
    serverProc.kill();
    process.exit(0);
  });

  await serverProc.exited;
}

/**
 * When running the CLI directly from the source tree (e.g. during development),
 * use a `file:` reference to the local package so the scaffolded project gets
 * the in-development code rather than the last published npm version.
 * In a normal install (bunx bunbase / npx bunbase) __dirname resolves inside
 * node_modules and the `file:` path won't exist, so we fall back to "latest".
 */
function resolveBunBaseVersion(_projectDir: string): string {
  // import.meta.dir is src/cli/ — two levels up reaches packages/bunbase/
  const packageRoot = resolve(import.meta.dir, "../..");
  const packageJsonPath = join(packageRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(packageJsonPath, "utf8"));
      if (pkg.name === "bunbase") {
        // Running from source — point directly at the local package
        return `file:${packageRoot}`;
      }
    } catch {
      // fall through
    }
  }
  return "latest";
}

async function waitForServer(
  proc: ReturnType<typeof Bun.spawn>,
  port: number,
  timeoutMs = 10000,
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }

    // Check if process died
    if (proc.exitCode !== null) return false;

    await Bun.sleep(300);
  }

  return false;
}
