import type { DatabaseAdapter } from "../adapter.ts";

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
        console.log(`[BunBase] Created database "${dbName}"`);
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

    await this.sql`
      CREATE TABLE IF NOT EXISTS _api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        expires_at BIGINT,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
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
    await this.sql`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON _api_keys(user_id)`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON _api_keys(key_hash)`;
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
