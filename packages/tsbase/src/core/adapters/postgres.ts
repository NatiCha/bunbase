import type { DatabaseAdapter } from "../adapter.ts";
import { getColumns, getTableName } from "drizzle-orm";
import type { Column } from "drizzle-orm";

/**
 * Map Drizzle column types to Postgres DDL types.
 * Handles both PgColumn and SQLiteColumn columnType strings.
 */
function pgColumnType(column: Column): string {
  const type = (column as any).columnType as string;
  // Postgres-native types
  if (type.includes("PgText") || type.includes("SQLiteText")) return "TEXT";
  if (type.includes("PgInteger") || type.includes("SQLiteInteger")) return "INTEGER";
  if (type.includes("PgBigInt")) return "BIGINT";
  if (type.includes("PgBoolean")) return "BOOLEAN";
  if (type.includes("PgReal") || type.includes("SQLiteReal")) return "REAL";
  if (type.includes("PgTimestamp")) return "TIMESTAMP";
  if (type.includes("PgUUID")) return "UUID";
  if (type.includes("PgJsonb")) return "JSONB";
  if (type.includes("PgJson")) return "JSON";
  if (type.includes("PgVarchar")) return "VARCHAR";
  if (type.includes("PgNumeric")) return "NUMERIC";
  if (type.includes("Blob")) return "BYTEA";
  return "TEXT";
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly dialect = "postgres" as const;
  private sql: any; // Bun.SQL instance
  private connectionUrl: string;

  constructor(connectionUrl: string) {
    const { SQL } = require("bun") as typeof import("bun");
    this.connectionUrl = connectionUrl;
    this.sql = new SQL(connectionUrl);
  }

  /**
   * Ensure the target database exists. If not, connect to the default
   * "postgres" maintenance database and CREATE DATABASE automatically —
   * the same zero-config experience users get with SQLite.
   */
  private async ensureDatabase(): Promise<void> {
    const { SQL } = require("bun") as typeof import("bun");
    try {
      // Probe the connection — this will throw if the DB doesn't exist
      await this.sql`SELECT 1`;
    } catch (err: any) {
      const msg: string = err?.message ?? "";
      if (!msg.includes("does not exist") && !msg.includes("database") ) {
        throw err; // Unrelated error — surface it
      }

      // Parse the database name out of the connection URL
      const url = new URL(this.connectionUrl);
      const dbName = url.pathname.replace(/^\//, "");
      if (!dbName) throw err;

      // Connect to the maintenance DB and create the target DB
      url.pathname = "/postgres";
      const maintenance = new SQL(url.toString());
      try {
        await maintenance.unsafe(`CREATE DATABASE "${dbName}"`);
        console.log(`[TSBase] Created database "${dbName}"`);
      } finally {
        await maintenance.end();
      }

      // Reconnect the main pool to the (now-existing) database
      await this.sql.end();
      this.sql = new SQL(this.connectionUrl);
    }
  }

  async bootstrapInternalTables(): Promise<void> {
    await this.ensureDatabase();
    await this.sql`
      CREATE TABLE IF NOT EXISTS _sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _files (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        record_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _verification_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        type TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _oauth_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _request_logs (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        user_id TEXT,
        timestamp TEXT NOT NULL
      )
    `;

    // Indexes
    await this.sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON _sessions(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON _sessions(expires_at)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_files_collection_record ON _files(collection, record_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_verification_tokens_user ON _verification_tokens(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON _oauth_accounts(user_id)`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON _oauth_accounts(provider, provider_account_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON _request_logs(timestamp)`;
  }

  async createUserTables(schema: Record<string, unknown>): Promise<void> {
    for (const table of Object.values(schema)) {
      if (typeof table !== "object" || table === null) continue;

      let tableName: string;
      try {
        tableName = getTableName(table as any);
      } catch {
        continue;
      }

      if (tableName.startsWith("_")) continue;

      const columns = getColumns(table as any);
      const colDefs: string[] = [];

      for (const [, col] of Object.entries(columns)) {
        const c = col as Column;
        const colName = (c as any).name as string;
        const colType = pgColumnType(c);
        let def = `"${colName}" ${colType}`;

        if ((c as any).primary) def += " PRIMARY KEY";
        if ((c as any).notNull) def += " NOT NULL";
        if ((c as any).isUnique) def += " UNIQUE";
        if ((c as any).hasDefault && (c as any).default !== undefined) {
          const defaultVal = (c as any).default;
          if (typeof defaultVal === "string") {
            def += ` DEFAULT '${defaultVal}'`;
          } else if (typeof defaultVal === "number" || typeof defaultVal === "boolean") {
            def += ` DEFAULT ${defaultVal}`;
          }
        }

        colDefs.push(def);
      }

      const createSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(", ")})`;
      await this.sql.unsafe(createSql);
    }
  }

  async injectTimestampColumns(tableNames: string[]): Promise<void> {
    for (const table of tableNames) {
      // Postgres supports ADD COLUMN IF NOT EXISTS
      await this.sql.unsafe(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)`,
      );
      await this.sql.unsafe(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS updated_at TEXT NOT NULL DEFAULT (NOW()::TEXT)`,
      );
    }
  }

  async rawQuery<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
    // Convert $param style to Bun.SQL positional params
    const { query, values } = convertParams(sql, params);
    const rows = await this.sql.unsafe(query, values);
    return Array.from(rows) as T[];
  }

  async rawQueryOne<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    const rows = await this.rawQuery<T>(sql, params);
    return rows[0] ?? null;
  }

  async rawExecute(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const { query, values } = convertParams(sql, params);
    await this.sql.unsafe(query, values);
  }

  quoteIdentifier(name: string): string {
    return `"${name}"`;
  }

  close(): void {
    this.sql.close();
  }
}

/**
 * Convert SQLite-style $param queries to positional $1, $2, ... queries
 * for Postgres. Also remaps column aliases like `duration_ms as durationMs`
 * since both dialects support that syntax.
 */
function convertParams(
  sql: string,
  params?: Record<string, unknown>,
): { query: string; values: unknown[] } {
  if (!params || Object.keys(params).length === 0) {
    return { query: sql, values: [] };
  }

  const values: unknown[] = [];
  let idx = 0;

  const query = sql.replace(/\$([a-zA-Z_]\w*)/g, (match, name) => {
    const key = `$${name}`;
    if (key in params) {
      idx++;
      values.push(params[key]);
      return `$${idx}`;
    }
    return match;
  });

  return { query, values };
}
