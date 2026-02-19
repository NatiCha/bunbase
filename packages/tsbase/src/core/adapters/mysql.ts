import type { DatabaseAdapter } from "../adapter.ts";
import { getColumns, getTableName } from "drizzle-orm";
import type { Column } from "drizzle-orm";

/**
 * Map Drizzle column types to MySQL DDL types.
 * Handles MySqlColumn, PgColumn, and SQLiteColumn columnType strings.
 */
function mysqlColumnType(column: Column): string {
  const type = (column as any).columnType as string;
  if (type.includes("MySqlText") || type.includes("PgText") || type.includes("SQLiteText")) return "TEXT";
  if (type.includes("MySqlInt") || type.includes("PgInteger") || type.includes("SQLiteInteger")) return "INTEGER";
  if (type.includes("MySqlBigInt") || type.includes("PgBigInt")) return "BIGINT";
  if (type.includes("MySqlBoolean") || type.includes("PgBoolean")) return "TINYINT(1)";
  if (type.includes("MySqlReal") || type.includes("PgReal") || type.includes("SQLiteReal")) return "DOUBLE";
  if (type.includes("MySqlTimestamp") || type.includes("PgTimestamp")) return "DATETIME";
  if (type.includes("MySqlVarChar") || type.includes("PgVarchar")) return "VARCHAR(255)";
  if (type.includes("MySqlDecimal") || type.includes("PgNumeric")) return "DECIMAL(10,2)";
  if (type.includes("MySqlJson") || type.includes("PgJsonb") || type.includes("PgJson")) return "JSON";
  if (type.includes("Blob")) return "LONGBLOB";
  return "TEXT";
}

export class MysqlAdapter implements DatabaseAdapter {
  readonly dialect = "mysql" as const;
  private sql: any; // Bun.SQL instance
  private connectionUrl: string;

  constructor(connectionUrl: string) {
    const { SQL } = require("bun") as typeof import("bun");
    this.connectionUrl = connectionUrl;
    this.sql = new SQL(connectionUrl);
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
      const maintenance = new SQL(url.toString());
      try {
        await maintenance.unsafe(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
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

    // Indexes — MySQL uses CREATE INDEX IF NOT EXISTS syntax differently; use DROP+CREATE or just swallow errors
    const idxStmts = [
      "CREATE INDEX idx_sessions_user_id ON `_sessions`(`user_id`(191))",
      "CREATE INDEX idx_sessions_expires_at ON `_sessions`(`expires_at`)",
      "CREATE INDEX idx_files_collection_record ON `_files`(`collection`(191), `record_id`(191))",
      "CREATE INDEX idx_verification_tokens_user ON `_verification_tokens`(`user_id`(191))",
      "CREATE INDEX idx_oauth_accounts_user ON `_oauth_accounts`(`user_id`(191))",
      "CREATE UNIQUE INDEX idx_oauth_accounts_provider ON `_oauth_accounts`(`provider`(191), `provider_account_id`(191))",
      "CREATE INDEX idx_request_logs_timestamp ON `_request_logs`(`timestamp`(191))",
    ];
    for (const stmt of idxStmts) {
      try {
        await this.sql.unsafe(stmt);
      } catch {
        // Index already exists
      }
    }
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
      let primaryKeyCol: string | null = null;
      const uniqueCols: string[] = [];

      for (const [, col] of Object.entries(columns)) {
        const c = col as Column;
        const colName = (c as any).name as string;
        const colType = mysqlColumnType(c);
        let def = `\`${colName}\` ${colType}`;

        if ((c as any).notNull || (c as any).primary) def += " NOT NULL";
        // Don't add inline UNIQUE — TEXT columns require a key length prefix,
        // so we collect them and emit table-level UNIQUE KEY constraints below
        if ((c as any).hasDefault && (c as any).default !== undefined) {
          const defaultVal = (c as any).default;
          if (typeof defaultVal === "string") {
            // MySQL 8.0.13+: TEXT columns require expression syntax DEFAULT ('value')
            def += ` DEFAULT ('${defaultVal}')`;
          } else if (typeof defaultVal === "number" || typeof defaultVal === "boolean") {
            def += ` DEFAULT ${defaultVal}`;
          }
        }

        colDefs.push(def);

        if ((c as any).primary) {
          primaryKeyCol = colName;
        }
        if ((c as any).isUnique && !(c as any).primary) {
          uniqueCols.push(colName);
        }
      }

      if (primaryKeyCol) {
        colDefs.push(`PRIMARY KEY (\`${primaryKeyCol}\`(191))`);
      }
      for (const col of uniqueCols) {
        colDefs.push(`UNIQUE KEY \`uq_${tableName}_${col}\` (\`${col}\`(191))`);
      }

      const createSql = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (${colDefs.join(", ")})`;
      await this.sql.unsafe(createSql);
    }
  }

  async injectTimestampColumns(tableNames: string[]): Promise<void> {
    for (const table of tableNames) {
      // MySQL lacks ADD COLUMN IF NOT EXISTS — use try/catch like SQLite
      try {
        await this.sql.unsafe(
          `ALTER TABLE \`${table}\` ADD COLUMN \`created_at\` TEXT NOT NULL DEFAULT (NOW())`,
        );
      } catch {
        // Column already exists
      }
      try {
        await this.sql.unsafe(
          `ALTER TABLE \`${table}\` ADD COLUMN \`updated_at\` TEXT NOT NULL DEFAULT (NOW())`,
        );
      } catch {
        // Column already exists
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

  async rawExecute(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
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
