import type { DatabaseAdapter } from "../adapter.ts";

interface PoolOptions {
  max?: number;
  idleTimeout?: number;
}

export function buildSqlOptions(url: string, pool?: PoolOptions) {
  const opts: { url: string; max?: number; idleTimeout?: number } = { url };
  if (pool?.max !== undefined) opts.max = pool.max;
  if (pool?.idleTimeout !== undefined) opts.idleTimeout = pool.idleTimeout;
  return opts;
}

/**
 * Probe the target Postgres database and CREATE DATABASE if missing.
 * Runs against a throwaway `max:1` SQL client that is closed before returning
 * so the caller can build the real shared pool afterwards. Must run before
 * the shared client is constructed because Drizzle holds the SQL reference
 * with no swap API — re-pointing it post-hoc is not supported.
 */
export async function ensureDatabaseExists(connectionUrl: string): Promise<void> {
  const { SQL } = require("bun") as typeof import("bun");
  const probe = new SQL({ url: connectionUrl, max: 1 });
  try {
    await probe`SELECT 1`;
    return;
  } catch (err: any) {
    const msg: string = err?.message ?? "";
    if (!msg.includes("does not exist") && !msg.includes("database")) {
      throw err;
    }

    const url = new URL(connectionUrl);
    const dbName = url.pathname.replace(/^\//, "");
    if (!dbName) throw err;

    url.pathname = "/postgres";
    const maintenance = new SQL({ url: url.toString(), max: 1 });
    try {
      await maintenance.unsafe(`CREATE DATABASE "${dbName}"`);
      console.log(`[BunBase] Created database "${dbName}"`);
    } finally {
      await maintenance.end();
    }
  } finally {
    await probe.end().catch(() => {
      // Probe may have errored before the connection was usable; ignore.
    });
  }
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly dialect = "postgres" as const;
  // Shared SQL client — owned by this adapter for lifecycle (close()).
  // The same instance is held by the drizzle client; do NOT close it from the
  // drizzle side. Closing one silently closes the other.
  private sql: any;
  private connectionUrl: string;

  constructor(sql: any, connectionUrl: string) {
    this.sql = sql;
    this.connectionUrl = connectionUrl;
  }

  async bootstrapInternalTables(): Promise<void> {
    // Auto-create the target DB if missing, BEFORE the shared SQL pool issues
    // its first query. `new SQL(...)` in Bun is lazy — no connection until
    // first query — so we're safe to do this here.
    await ensureDatabaseExists(this.connectionUrl);
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

    // Migration: add columns to _sessions if missing
    await this.sql`
      DO $$ BEGIN
        ALTER TABLE _sessions ADD COLUMN mfa_verified INTEGER;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;
    await this.sql`
      DO $$ BEGIN
        ALTER TABLE _sessions ADD COLUMN user_agent TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;
    await this.sql`
      DO $$ BEGIN
        ALTER TABLE _sessions ADD COLUMN ip_address TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;
    await this.sql`
      DO $$ BEGIN
        ALTER TABLE _sessions ADD COLUMN is_guest INTEGER DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _mfa_totp (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        encrypted_secret TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _mfa_backup_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _passkey_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        device_type TEXT,
        backed_up INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
        last_used_at TEXT
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _invites (
        id TEXT PRIMARY KEY,
        email TEXT,
        token_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        invited_by TEXT NOT NULL,
        max_uses INTEGER DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT),
        updated_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _organization_members (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _organization_invites (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        token_hash TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS _jwt_revocations (
        id TEXT PRIMARY KEY,
        jti TEXT NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (NOW()::TEXT)
      )
    `;

    // Indexes
    await this.sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON _sessions(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON _sessions(expires_at)`;
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_files_collection_record ON _files(collection, record_id)`;
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_verification_tokens_user ON _verification_tokens(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON _oauth_accounts(user_id)`;
    await this
      .sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON _oauth_accounts(provider, provider_account_id)`;
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON _request_logs(timestamp)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON _api_keys(user_id)`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON _api_keys(key_hash)`;

    // MFA indexes
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user ON _mfa_backup_codes(user_id)`;
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user ON _passkey_credentials(user_id)`;

    // Invite, org, JWT indexes
    await this.sql`CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON _invites(token_hash)`;
    await this
      .sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_unique ON _organization_members(org_id, user_id)`;
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_org_members_user ON _organization_members(user_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_org_members_org ON _organization_members(org_id)`;
    await this.sql`CREATE INDEX IF NOT EXISTS idx_org_invites_org ON _organization_invites(org_id)`;
    await this
      .sql`CREATE INDEX IF NOT EXISTS idx_jwt_revocations_expires ON _jwt_revocations(expires_at)`;
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

  async rawExecute(sql: string, params?: Record<string, unknown>): Promise<void> {
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
