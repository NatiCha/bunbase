import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ResolvedConfig } from "./config.ts";

export function createDatabase(config: ResolvedConfig) {
  const dbPath = config.dbPath;
  const dir = dirname(dbPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath, { create: true });

  // Performance pragmas
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA foreign_keys = ON");

  const db = drizzle({ client: sqlite });

  return { db, sqlite };
}

export function runUserMigrations(
  db: ReturnType<typeof drizzle>,
  config: ResolvedConfig,
): void {
  if (!existsSync(config.migrationsPath)) {
    const message = `TSBase: migrations folder not found at "${config.migrationsPath}"`;
    if (config.development) {
      console.warn(`${message}. Continuing in development mode.`);
      return;
    }
    throw new Error(message);
  }

  try {
    const result = migrate(db, { migrationsFolder: config.migrationsPath });
    if (result && typeof result === "object" && "exitCode" in result) {
      throw new Error(
        `TSBase: migration initialization failed with exit code "${result.exitCode}"`,
      );
    }
  } catch (error) {
    if (config.development) {
      console.warn("TSBase: failed to run migrations in development mode.", error);
      return;
    }
    throw error;
  }
}
