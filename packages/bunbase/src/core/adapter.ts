import type { Dialect } from "./db-types.ts";

/**
 * Adapter interface for dialect-specific raw database operations.
 * @module
 */

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
