import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ResolvedConfig } from "./config.ts";
import type { AnyDb, Dialect } from "./db-types.ts";
import type { DatabaseAdapter } from "./adapter.ts";
import { SqliteAdapter } from "./adapters/sqlite.ts";
import { PostgresAdapter } from "./adapters/postgres.ts";
import { MysqlAdapter } from "./adapters/mysql.ts";

export interface DatabaseResult {
  db: AnyDb;
  dialect: Dialect;
  adapter: DatabaseAdapter;
}

export function createDatabase(config: ResolvedConfig, schema?: Record<string, unknown>, relations?: unknown): DatabaseResult {
  if (config.database.driver === "postgres") {
    return createPostgresDatabase(config, schema, relations);
  }
  if (config.database.driver === "mysql") {
    return createMysqlDatabase(config, schema, relations);
  }
  return createSqliteDatabase(config, schema, relations);
}

function createSqliteDatabase(config: ResolvedConfig, schema?: Record<string, unknown>, relations?: unknown): DatabaseResult {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const { drizzle } = require("drizzle-orm/bun-sqlite") as typeof import("drizzle-orm/bun-sqlite");

  const dbPath = config.database.url;
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

  const db = drizzle({ client: sqlite, schema: schema as any, relations: relations as any });
  const adapter = new SqliteAdapter(sqlite);

  return { db, dialect: "sqlite", adapter };
}

function createPostgresDatabase(config: ResolvedConfig, schema?: Record<string, unknown>, relations?: unknown): DatabaseResult {
  const { SQL } = require("bun") as typeof import("bun");
  const { drizzle } = require("drizzle-orm/bun-sql") as typeof import("drizzle-orm/bun-sql");

  const client = new SQL(config.database.url);
  const db = drizzle({ client, schema: schema as any, relations: relations as any });
  const adapter = new PostgresAdapter(config.database.url);

  return { db, dialect: "postgres", adapter };
}

function createMysqlDatabase(config: ResolvedConfig, schema?: Record<string, unknown>, relations?: unknown): DatabaseResult {
  const { SQL } = require("bun") as typeof import("bun");
  const { drizzle } = require("drizzle-orm/bun-sql/mysql") as typeof import("drizzle-orm/bun-sql/mysql");

  const client = new SQL(config.database.url);
  const db = drizzle({ client, schema: schema as any, relations: relations as any });
  const adapter = new MysqlAdapter(config.database.url);

  return { db, dialect: "mysql", adapter };
}

export async function runUserMigrations(
  db: AnyDb,
  config: ResolvedConfig,
): Promise<void> {
  if (!existsSync(config.migrationsPath)) {
    if (config.development) {
      console.warn(`TSBase: migrations folder not found at "${config.migrationsPath}". Skipping migrations in development mode.`);
      return;
    }
    throw new Error(`TSBase: migrations folder not found at "${config.migrationsPath}". Run "bun db:generate" to create migrations before deploying.`);
  }

  try {
    if (config.database.driver === "postgres") {
      const { migrate } = await import("drizzle-orm/bun-sql/migrator");
      await migrate(db as any, { migrationsFolder: config.migrationsPath });
    } else if (config.database.driver === "mysql") {
      const { migrate } = await import("drizzle-orm/bun-sql/mysql/migrator");
      await migrate(db as any, { migrationsFolder: config.migrationsPath });
    } else {
      const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
      const result = migrate(db as any, { migrationsFolder: config.migrationsPath });
      if (result && typeof result === "object" && "exitCode" in result) {
        throw new Error(
          `TSBase: migration initialization failed with exit code "${result.exitCode}"`,
        );
      }
    }
  } catch (error) {
    if (config.development) {
      console.warn("TSBase: failed to run migrations in development mode.", error);
      return;
    }
    throw error;
  }
}
