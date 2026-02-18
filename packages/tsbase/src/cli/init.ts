import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { text, select, multiSelect, closePrompts } from "./prompts.ts";
import {
  getTemplate,
  TEMPLATE_OPTIONS,
  OAUTH_OPTIONS,
  type TemplateType,
  type OAuthProvider,
} from "./templates.ts";
import { printSummary } from "./summary.ts";

const STATIC_FILES: Record<string, string> = {
  "drizzle.config.ts": `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  dbCredentials: {
    url: "./data/db.sqlite",
  },
});
`,

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

  ".gitignore": `node_modules
dist
data/
drizzle/
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
  // Welcome banner
  console.log(`\n  \x1b[1m\x1b[36mTSBase\x1b[0m — create a new project\n`);

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

  // 3. Select template
  let templateType: TemplateType = "empty";
  if (!nonInteractive) {
    templateType = await select("What are you building?", TEMPLATE_OPTIONS);
  }

  // 4. Select OAuth providers
  let oauthProviders: OAuthProvider[] = [];
  if (!nonInteractive) {
    oauthProviders = await multiSelect(
      "OAuth providers? (optional)",
      OAUTH_OPTIONS,
    );
  }

  // Done with prompts
  closePrompts();

  // 5. Generate template
  const template = getTemplate(templateType, oauthProviders);

  console.log(`\n  Creating ${projectName}...`);

  // Create directories
  mkdirSync(join(projectDir, "src"), { recursive: true });

  // Write template files
  const files: Record<string, string> = {
    "src/index.ts": template.indexTs,
    "src/schema.ts": template.schema,
    "src/rules.ts": template.rules,
    ".env": template.env,
    ...STATIC_FILES,
  };

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(projectDir, filePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await Bun.write(fullPath, content);
    console.log(`  \x1b[32m+\x1b[0m ${filePath}`);
  }

  // Write package.json
  const packageJson = {
    name: projectName,
    version: "0.1.0",
    type: "module",
    scripts: {
      dev: "bun --hot src/index.ts",
      start: "NODE_ENV=production bun src/index.ts",
      studio: "bunx drizzle-kit studio",
    },
    dependencies: {
      tsbase: "latest",
    },
    devDependencies: {
      "@types/bun": "latest",
      "drizzle-kit": "latest",
    },
  };

  await Bun.write(
    join(projectDir, "package.json"),
    JSON.stringify(packageJson, null, 2),
  );
  console.log(`  \x1b[32m+\x1b[0m package.json`);

  // 6. Auto-install
  console.log(`\n  Installing dependencies...\n`);
  try {
    await Bun.$`cd ${projectDir} && bun install`.quiet();
    console.log(`  \x1b[32m✓\x1b[0m Dependencies installed`);
  } catch (err) {
    console.error(`\n  \x1b[31m✗\x1b[0m Failed to install dependencies.`);
    console.error(`  Run \x1b[1mcd ${projectName} && bun install\x1b[0m manually.\n`);
    process.exit(1);
  }

  // 7. Auto-start dev server
  console.log(`\n  Starting dev server...\n`);

  const port = 3000;
  const serverProc = Bun.spawn(["bun", "--hot", "src/index.ts"], {
    cwd: projectDir,
    stdout: "inherit",
    stderr: "inherit",
  });

  // Wait for server to be ready
  const ready = await waitForServer(serverProc, port);

  if (!ready && serverProc.exitCode !== null) {
    console.error(`\n  \x1b[31m✗\x1b[0m Server failed to start (exit code ${serverProc.exitCode}).\n`);
    console.error(`  Try running manually:`);
    console.error(`    cd ${projectName} && bun --hot src/index.ts\n`);
    process.exit(1);
  }

  if (!ready) {
    console.log(`\n  \x1b[33m⚠\x1b[0m Server is taking longer than expected to start...`);
  }

  printSummary({
    projectName,
    tables: template.tables,
    oauth: oauthProviders,
    port,
  });

  // Offer to open admin UI
  if (!nonInteractive) {
    const openAdmin = await promptYesNo("  Open admin UI in browser? (Y/n): ");
    if (openAdmin) {
      const cmd = process.platform === "darwin" ? "open" : "xdg-open";
      Bun.spawn([cmd, `http://localhost:${port}/_admin`]);
    }
  }

  // Keep process alive until server exits or Ctrl+C
  process.on("SIGINT", () => {
    serverProc.kill();
    process.exit(0);
  });

  await serverProc.exited;
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


function promptYesNo(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(message);
    const { createInterface } = require("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", (answer: string) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "" || trimmed.startsWith("y"));
    });
  });
}
