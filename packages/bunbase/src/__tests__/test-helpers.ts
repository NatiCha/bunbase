import type { ResolvedConfig } from "../core/config.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import { getInternalSchema } from "../core/internal-schema.ts";
import { SqliteAdapter } from "../core/adapters/sqlite.ts";
import type { DatabaseAdapter } from "../core/adapter.ts";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { AnyDb } from "../core/db-types.ts";

export function makeResolvedConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  const authOverrides = (overrides.auth ?? {}) as Partial<ResolvedConfig["auth"]>;
  const storageOverrides =
    (overrides.storage ?? {}) as Partial<ResolvedConfig["storage"]>;
  const corsOverrides = (overrides.cors ?? {}) as Partial<ResolvedConfig["cors"]>;
  const databaseOverrides = overrides.database ?? { driver: "sqlite" as const, url: overrides.dbPath ?? "./data/db.sqlite" };

  const realtimeOverrides = (overrides.realtime ?? {}) as Partial<ResolvedConfig["realtime"]>;

  return {
    auth: {
      tokenExpiry: authOverrides.tokenExpiry ?? 60 * 60,
      email: authOverrides.email,
      oauth: authOverrides.oauth,
      apiKeys: authOverrides.apiKeys ?? { defaultExpirationDays: 365, maxExpirationDays: null },
    },
    storage: {
      driver: storageOverrides.driver ?? "local",
      localPath: storageOverrides.localPath ?? "./data/uploads",
      s3: storageOverrides.s3,
      maxFileSize: storageOverrides.maxFileSize ?? 10 * 1024 * 1024,
      allowedMimeTypes: storageOverrides.allowedMimeTypes,
    },
    cors: {
      origins: corsOverrides.origins ?? [],
    },
    realtime: {
      enabled: realtimeOverrides.enabled ?? false,
    },
    development: overrides.development ?? true,
    database: databaseOverrides,
    dbPath: overrides.dbPath ?? databaseOverrides.url ?? "./data/db.sqlite",
    migrationsPath: overrides.migrationsPath ?? "./drizzle",
    trustedProxies: overrides.trustedProxies ?? [],
    frontend: overrides.frontend,
  };
}

/**
 * Setup a test database with internal tables bootstrapped.
 * Returns sqlite, drizzle db, adapter, and internalSchema for use in tests.
 */
export function setupTestDb(): {
  sqlite: Database;
  db: AnyDb;
  adapter: DatabaseAdapter;
  internalSchema: InternalSchema;
} {
  const sqlite = new Database(":memory:");
  const adapter = new SqliteAdapter(sqlite);
  // bootstrapInternalTables is synchronous for SQLite
  adapter.bootstrapInternalTables();
  const db = drizzle({ client: sqlite });
  const internalSchema = getInternalSchema("sqlite");
  return { sqlite, db, adapter, internalSchema };
}
