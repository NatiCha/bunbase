import type { DatabaseAdapter } from "../adapter.ts";

interface PoolOptions {
  max?: number;
  idleTimeout?: number;
}

function buildSqlOptions(url: string, pool?: PoolOptions) {
  const opts: { url: string; max?: number; idleTimeout?: number } = { url };
  if (pool?.max !== undefined) opts.max = pool.max;
  if (pool?.idleTimeout !== undefined) opts.idleTimeout = pool.idleTimeout;
  return opts;
}

export class MysqlAdapter implements DatabaseAdapter {
  readonly dialect = "mysql" as const;
  private sql: any; // Bun.SQL instance
  private connectionUrl: string;
  private pool?: PoolOptions;

  constructor(connectionUrl: string, pool?: PoolOptions) {
    const { SQL } = require("bun") as typeof import("bun");
    this.connectionUrl = connectionUrl;
    this.pool = pool;
    this.sql = new SQL(buildSqlOptions(connectionUrl, pool));
  }

  /**
   * Ensure the target database exists. MySQL supports `CREATE DATABASE IF NOT EXISTS`
   * natively, so we connect to the server without a database and create it.
   */
  private async ensureDatabase(): Promise<void> {
    const { SQL } = require("bun") as typeof import("bun");
    try {
      await this.sql`SELECT 1`;
    } catch (err: any) {
      const msg: string = err?.message ?? "";
      // Only auto-create for "Unknown database" — other errors (auth, network) should surface
      if (!msg.includes("Unknown database")) {
        throw err;
      }

      const url = new URL(this.connectionUrl);
      const dbName = url.pathname.replace(/^\//, "");
      if (!dbName) throw err;

      // Connect to the built-in "mysql" system database (always exists)
      url.pathname = "/mysql";
      // Maintenance pool is used for a single CREATE DATABASE — cap at 1 conn.
      const maintenance = new SQL({ url: url.toString(), max: 1 });
      try {
        await maintenance.unsafe(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
        console.log(`[BunBase] Created database "${dbName}"`);
      } finally {
        await maintenance.end();
      }

      // Reconnect the main pool to the (now-existing) database
      await this.sql.end();
      this.sql = new SQL(buildSqlOptions(this.connectionUrl, this.pool));
    }
  }

  async bootstrapInternalTables(): Promise<void> {
    await this.ensureDatabase();

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_sessions\` (
        \`id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`expires_at\` BIGINT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_files\` (
        \`id\` TEXT NOT NULL,
        \`collection\` TEXT NOT NULL,
        \`record_id\` TEXT NOT NULL,
        \`filename\` TEXT NOT NULL,
        \`mime_type\` TEXT NOT NULL,
        \`size\` INTEGER NOT NULL,
        \`storage_path\` TEXT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_verification_tokens\` (
        \`id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`token_hash\` TEXT NOT NULL,
        \`type\` TEXT NOT NULL,
        \`expires_at\` BIGINT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_oauth_accounts\` (
        \`id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`provider\` TEXT NOT NULL,
        \`provider_account_id\` TEXT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_request_logs\` (
        \`id\` TEXT NOT NULL,
        \`method\` TEXT NOT NULL,
        \`path\` TEXT NOT NULL,
        \`status\` INTEGER NOT NULL,
        \`duration_ms\` INTEGER NOT NULL,
        \`user_id\` TEXT,
        \`timestamp\` TEXT NOT NULL,
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_api_keys\` (
        \`id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`key_hash\` CHAR(64) NOT NULL,
        \`key_prefix\` TEXT NOT NULL,
        \`name\` TEXT NOT NULL,
        \`expires_at\` BIGINT,
        \`last_used_at\` TEXT,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    // Migration: add columns to _sessions if missing
    const sessionCols = [
      "ALTER TABLE `_sessions` ADD COLUMN `mfa_verified` INTEGER",
      "ALTER TABLE `_sessions` ADD COLUMN `user_agent` TEXT",
      "ALTER TABLE `_sessions` ADD COLUMN `ip_address` TEXT",
      "ALTER TABLE `_sessions` ADD COLUMN `is_guest` INTEGER DEFAULT 0",
    ];
    for (const stmt of sessionCols) {
      try {
        await this.sql.unsafe(stmt);
      } catch {
        // Column already exists
      }
    }

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_mfa_totp\` (
        \`id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`encrypted_secret\` TEXT NOT NULL,
        \`verified\` INTEGER NOT NULL DEFAULT 0,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191)),
        UNIQUE KEY \`idx_mfa_totp_user\` (\`user_id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_mfa_backup_codes\` (
        \`id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`code_hash\` TEXT NOT NULL,
        \`used\` INTEGER NOT NULL DEFAULT 0,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_passkey_credentials\` (
        \`id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`public_key\` TEXT NOT NULL,
        \`counter\` INTEGER NOT NULL DEFAULT 0,
        \`device_type\` TEXT,
        \`backed_up\` INTEGER NOT NULL DEFAULT 0,
        \`transports\` TEXT,
        \`name\` TEXT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        \`last_used_at\` TEXT,
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_invites\` (
        \`id\` TEXT NOT NULL,
        \`email\` TEXT,
        \`token_hash\` TEXT NOT NULL,
        \`role\` TEXT NOT NULL DEFAULT 'user',
        \`invited_by\` TEXT NOT NULL,
        \`max_uses\` INTEGER DEFAULT 1,
        \`use_count\` INTEGER NOT NULL DEFAULT 0,
        \`expires_at\` BIGINT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_organizations\` (
        \`id\` TEXT NOT NULL,
        \`name\` TEXT NOT NULL,
        \`slug\` TEXT NOT NULL,
        \`owner_id\` TEXT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        \`updated_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191)),
        UNIQUE KEY \`idx_org_slug\` (\`slug\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_organization_members\` (
        \`id\` TEXT NOT NULL,
        \`org_id\` TEXT NOT NULL,
        \`user_id\` TEXT NOT NULL,
        \`role\` TEXT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191)),
        UNIQUE KEY \`idx_org_members_unique\` (\`org_id\`(191), \`user_id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_organization_invites\` (
        \`id\` TEXT NOT NULL,
        \`org_id\` TEXT NOT NULL,
        \`email\` TEXT NOT NULL,
        \`role\` TEXT NOT NULL DEFAULT 'member',
        \`token_hash\` TEXT NOT NULL,
        \`invited_by\` TEXT NOT NULL,
        \`expires_at\` BIGINT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191))
      )
    `);

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS \`_jwt_revocations\` (
        \`id\` TEXT NOT NULL,
        \`jti\` TEXT NOT NULL,
        \`expires_at\` BIGINT NOT NULL,
        \`created_at\` TEXT NOT NULL DEFAULT (NOW()),
        PRIMARY KEY (\`id\`(191)),
        UNIQUE KEY \`idx_jwt_jti\` (\`jti\`(191))
      )
    `);

    // Indexes — MySQL uses CREATE INDEX IF NOT EXISTS syntax differently; use DROP+CREATE or just swallow errors
    const idxStmts = [
      "CREATE INDEX idx_sessions_user_id ON `_sessions`(`user_id`(191))",
      "CREATE INDEX idx_sessions_expires_at ON `_sessions`(`expires_at`)",
      "CREATE INDEX idx_files_collection_record ON `_files`(`collection`(191), `record_id`(191))",
      "CREATE INDEX idx_verification_tokens_user ON `_verification_tokens`(`user_id`(191))",
      "CREATE INDEX idx_oauth_accounts_user ON `_oauth_accounts`(`user_id`(191))",
      "CREATE UNIQUE INDEX idx_oauth_accounts_provider ON `_oauth_accounts`(`provider`(191), `provider_account_id`(191))",
      "CREATE INDEX idx_request_logs_timestamp ON `_request_logs`(`timestamp`(191))",
      "CREATE INDEX idx_api_keys_user_id ON `_api_keys`(`user_id`(191))",
      "CREATE UNIQUE INDEX idx_api_keys_hash ON `_api_keys`(`key_hash`)",
      "CREATE INDEX idx_mfa_backup_codes_user ON `_mfa_backup_codes`(`user_id`(191))",
      "CREATE INDEX idx_passkey_credentials_user ON `_passkey_credentials`(`user_id`(191))",
      "CREATE INDEX idx_invites_token_hash ON `_invites`(`token_hash`(191))",
      "CREATE INDEX idx_org_members_user ON `_organization_members`(`user_id`(191))",
      "CREATE INDEX idx_org_members_org ON `_organization_members`(`org_id`(191))",
      "CREATE INDEX idx_org_invites_org ON `_organization_invites`(`org_id`(191))",
      "CREATE INDEX idx_jwt_revocations_expires ON `_jwt_revocations`(`expires_at`)",
    ];
    for (const stmt of idxStmts) {
      try {
        await this.sql.unsafe(stmt);
      } catch {
        // Index already exists
      }
    }
  }

  quoteIdentifier(name: string): string {
    return `\`${name}\``;
  }

  async rawQuery<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
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

  close(): void {
    this.sql.close();
  }
}

/**
 * Convert $param-style named params to MySQL ? positional placeholders.
 * MySQL's unsafe() expects ? not $1/$2 like Postgres.
 */
function convertParams(
  sql: string,
  params?: Record<string, unknown>,
): { query: string; values: unknown[] } {
  if (!params || Object.keys(params).length === 0) {
    return { query: sql, values: [] };
  }

  const values: unknown[] = [];

  const query = sql.replace(/\$([a-zA-Z_]\w*)/g, (match, name) => {
    const key = `$${name}`;
    if (key in params) {
      values.push(params[key]);
      return "?";
    }
    return match;
  });

  return { query, values };
}
