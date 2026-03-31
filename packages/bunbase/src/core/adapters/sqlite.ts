import type { Database } from "bun:sqlite";
import type { DatabaseAdapter } from "../adapter.ts";

export class SqliteAdapter implements DatabaseAdapter {
  readonly dialect = "sqlite" as const;

  constructor(private sqlite: Database) {}

  async bootstrapInternalTables(): Promise<void> {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _files (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        record_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _verification_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        type TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _oauth_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _request_logs (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        user_id TEXT,
        timestamp TEXT NOT NULL
      )
    `);

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        expires_at INTEGER,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Add mfa_verified column to sessions if missing (migration for existing databases)
    try {
      this.sqlite.run("ALTER TABLE _sessions ADD COLUMN mfa_verified INTEGER");
    } catch {
      // Column already exists
    }

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _mfa_totp (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        encrypted_secret TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _mfa_backup_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS _passkey_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        device_type TEXT,
        backed_up INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      )
    `);

    // Indexes
    this.sqlite.run("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON _sessions(user_id)");
    this.sqlite.run("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON _sessions(expires_at)");
    this.sqlite.run(
      "CREATE INDEX IF NOT EXISTS idx_files_collection_record ON _files(collection, record_id)",
    );
    this.sqlite.run(
      "CREATE INDEX IF NOT EXISTS idx_verification_tokens_user ON _verification_tokens(user_id)",
    );
    this.sqlite.run(
      "CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON _oauth_accounts(user_id)",
    );
    this.sqlite.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON _oauth_accounts(provider, provider_account_id)",
    );
    this.sqlite.run(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON _request_logs(timestamp)",
    );
    this.sqlite.run("CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON _api_keys(user_id)");
    this.sqlite.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON _api_keys(key_hash)");

    // MFA indexes
    this.sqlite.run(
      "CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user ON _mfa_backup_codes(user_id)",
    );
    this.sqlite.run(
      "CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user ON _passkey_credentials(user_id)",
    );
  }

  async rawQuery<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
    return this.sqlite.query(sql).all((params as never) ?? {}) as T[];
  }

  async rawQueryOne<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    return (this.sqlite.query(sql).get((params as never) ?? {}) as T | null) ?? null;
  }

  async rawExecute(sql: string, params?: Record<string, unknown>): Promise<void> {
    this.sqlite.query(sql).run((params as never) ?? {});
  }

  quoteIdentifier(name: string): string {
    return `"${name}"`;
  }

  close(): void {
    this.sqlite.close();
  }
}
