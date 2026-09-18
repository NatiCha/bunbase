import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import libraryPackage from "../../package.json";
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
    "types": ["bun"],
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
.bunbase-service-key
`,
};

export interface InitOptions {
  projectName?: string;
  nonInteractive?: boolean;
  skipInstall?: boolean;
  noStart?: boolean;
}

export async function init({ projectName, nonInteractive, skipInstall, noStart }: InitOptions) {
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
    "src/index.test.ts": template.sampleTest,
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

  // Write package.json. The dependency versions are read from the library's own
  // package.json so the generated project pins EXACTLY what this CLI ships with:
  //  - the published package name (`@naticha/bunbase`)
  //  - the exact `drizzle-orm` / `drizzle-kit` versions the library is built
  //    against. drizzle-orm must match exactly across the dependency tree, or
  //    Bun installs two physical copies and Symbol-based table identity breaks.
  const versions = resolveDependencyVersions();
  const packageJson = {
    name: projectName,
    version: "0.0.1",
    type: "module",
    packageManager: "bun@1.4.2",
    engines: { bun: ">=1.4.2" },
    scripts: {
      // NODE_ENV must be declared in dev: the server treats an UNSET NODE_ENV as
      // production for security toggles, which would force Secure cookies over http.
      dev: "NODE_ENV=development bun --hot src/index.ts",
      start: "NODE_ENV=production bun src/index.ts",
      test: "bun test",
      type: "tsc --noEmit",
      "db:push": "bunx --bun drizzle-kit push --force",
      "db:generate": "bunx drizzle-kit generate",
      studio: "bunx drizzle-kit studio",
    },
    dependencies: {
      "@naticha/bunbase": versions.bunbase,
      "drizzle-orm": versions.drizzleOrm,
    },
    devDependencies: {
      "@types/bun": libraryPackage.devDependencies["@types/bun"],
      typescript: libraryPackage.devDependencies.typescript,
      "bun-plugin-tailwind": libraryPackage.devDependencies["bun-plugin-tailwind"],
      "drizzle-kit": versions.drizzleKit,
    },
  };

  await Bun.write(join(projectDir, "package.json"), JSON.stringify(packageJson, null, 2));

  const allFiles = [...Object.keys(files), "package.json"];
  clack.log.info(`Created files:\n${allFiles.map((f) => `  \x1b[2m${f}\x1b[0m`).join("\n")}`);

  if (skipInstall) {
    clack.outro(
      `Project created. Run: cd ${projectName} && bun install && bun run db:generate && bun run dev`,
    );
    return;
  }

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

  if (noStart) {
    clack.outro(`Project ready. Run: cd ${projectName} && bun run dev`);
    return;
  }

  const port = 3000;

  // 8. Auto-start dev server (both SQLite and Postgres)
  const serverSpinner = clack.spinner();
  serverSpinner.start("Starting dev server");

  const serverProc = Bun.spawn(["bun", "run", "dev"], {
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

interface DependencyVersions {
  /** Version range/spec for the `@naticha/bunbase` dependency. */
  bunbase: string;
  /** Exact `drizzle-orm` version the library pins. */
  drizzleOrm: string;
  /** Exact `drizzle-kit` version the library pins. */
  drizzleKit: string;
}

/** Read embedded package metadata, including in the compiled CLI. */
function resolveDependencyVersions(): DependencyVersions {
  return {
    bunbase: `^${libraryPackage.version}`,
    drizzleOrm: libraryPackage.dependencies["drizzle-orm"],
    drizzleKit: libraryPackage.devDependencies["drizzle-kit"],
  };
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
