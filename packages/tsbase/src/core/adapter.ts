import type { Dialect } from "./db-types.ts";

/**
 * DatabaseAdapter handles dialect-specific operations that can't
 * go through Drizzle ORM:
 *  - DDL bootstrap (CREATE TABLE, CREATE INDEX, ALTER TABLE)
 *  - SQLite PRAGMAs
 *  - Dynamic admin panel queries (table name is a runtime string)
 */
export interface DatabaseAdapter {
  dialect: Dialect;

  /** Create internal tables (_sessions, _files, etc.) and indexes */
  bootstrapInternalTables(): Promise<void>;

  /** Create user-defined tables from Drizzle schema */
  createUserTables(schema: Record<string, unknown>): Promise<void>;

  /** Add created_at and updated_at columns to user tables */
  injectTimestampColumns(tableNames: string[]): Promise<void>;

  /** Execute a dynamic query that returns rows (for admin panel) */
  rawQuery<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T[]>;

  /** Execute a dynamic query that returns a single row or null */
  rawQueryOne<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T | null>;

  /** Execute a dynamic statement with no return value */
  rawExecute(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<void>;

  /** Quote a table or column name for safe use in raw SQL */
  quoteIdentifier(name: string): string;

  /** Graceful shutdown */
  close(): void;
}
