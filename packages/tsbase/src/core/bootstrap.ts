import type { Database } from "bun:sqlite";
import { getColumns, getTableName, sql } from "drizzle-orm";
import type {
  SQLiteTableWithColumns,
  SQLiteColumn,
} from "drizzle-orm/sqlite-core";

export function bootstrapInternalTables(sqlite: Database) {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS _sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.run(`
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

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS _verification_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      type TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS _oauth_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Indexes
  sqlite.run(
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON _sessions(user_id)",
  );
  sqlite.run(
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON _sessions(expires_at)",
  );
  sqlite.run(
    "CREATE INDEX IF NOT EXISTS idx_files_collection_record ON _files(collection, record_id)",
  );
  sqlite.run(
    "CREATE INDEX IF NOT EXISTS idx_verification_tokens_user ON _verification_tokens(user_id)",
  );
  sqlite.run(
    "CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON _oauth_accounts(user_id)",
  );
  sqlite.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON _oauth_accounts(provider, provider_account_id)",
  );

  sqlite.run(`
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
  sqlite.run(
    "CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON _request_logs(timestamp)",
  );
}

export function injectTimestampColumns(sqlite: Database, tableNames: string[]) {
  for (const table of tableNames) {
    try {
      sqlite.run(
        `ALTER TABLE "${table}" ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))`,
      );
    } catch {
      // Column already exists - SQLite lacks IF NOT EXISTS for columns
    }

    try {
      sqlite.run(
        `ALTER TABLE "${table}" ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`,
      );
    } catch {
      // Column already exists
    }
  }
}

export function validateUsersTable(
  schema: Record<string, unknown>,
): SQLiteTableWithColumns<any> | null {
  const usersTable = Object.values(schema).find((table) => {
    if (typeof table !== "object" || table === null) return false;
    try {
      return getTableName(table as any) === "users";
    } catch {
      return false;
    }
  }) as SQLiteTableWithColumns<any> | undefined;

  if (!usersTable) return null;

  const columns = getColumns(usersTable);
  const columnNames = Object.keys(columns);

  const required = ["id", "email", "passwordHash", "role"];
  const missing = required.filter((col) => !columnNames.includes(col));

  if (missing.length > 0) {
    // Map camelCase to snake_case for the error message
    const missingDisplay = missing.map((col) => {
      if (col === "passwordHash") return "password_hash (passwordHash)";
      return col;
    });
    throw new Error(
      `TSBase: users table is missing required columns: ${missingDisplay.join(", ")}. ` +
        `Required columns: id, email, passwordHash (mapped to password_hash), role`,
    );
  }

  return usersTable;
}

function sqliteColumnType(column: SQLiteColumn): string {
  const type = column.columnType;
  if (type.includes("Integer")) return "INTEGER";
  if (type.includes("Real")) return "REAL";
  if (type.includes("Blob")) return "BLOB";
  return "TEXT";
}

export function createUserTables(
  sqlite: Database,
  schema: Record<string, unknown>,
) {
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
      const c = col as SQLiteColumn;
      const colName = c.name;
      const colType = sqliteColumnType(c);
      let def = `"${colName}" ${colType}`;

      if (c.primary) def += " PRIMARY KEY";
      if (c.notNull) def += " NOT NULL";
      if (c.isUnique) def += " UNIQUE";
      if (c.hasDefault && c.default !== undefined) {
        const defaultVal = c.default;
        if (typeof defaultVal === "string") {
          def += ` DEFAULT '${defaultVal}'`;
        } else if (
          typeof defaultVal === "number" ||
          typeof defaultVal === "boolean"
        ) {
          def += ` DEFAULT ${defaultVal}`;
        }
      }

      colDefs.push(def);
    }

    const createSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(", ")})`;
    sqlite.run(createSql);
  }
}

export function getUserTableNames(schema: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const table of Object.values(schema)) {
    if (typeof table !== "object" || table === null) continue;
    try {
      const name = getTableName(table as any);
      if (!name.startsWith("_")) {
        names.push(name);
      }
    } catch {
      // Not a table object
    }
  }
  return names;
}
