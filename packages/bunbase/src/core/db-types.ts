import type { Column, Table } from "drizzle-orm";
import type { BunMySqlDatabase } from "drizzle-orm/bun-sql/mysql";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import type { AnyRelations } from "drizzle-orm/relations";

/**
 * Dialect-agnostic Drizzle database and schema utility types.
 * @module
 */

/**
 * Dialect-agnostic database type.
 * Works with SQLite (bun:sqlite + drizzle), Postgres, and MySQL (Bun.sql + drizzle).
 */
export type AnyDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends AnyRelations = AnyRelations,
> =
  | SQLiteBunDatabase<TSchema, TRelations>
  | BunSQLDatabase<TSchema, TRelations>
  | BunMySqlDatabase<TSchema, TRelations>;

/**
 * Dialect-agnostic table type.
 * Works with `sqliteTable(...)`, `pgTable(...)`, and `mysqlTable(...)` definitions.
 */
export type AnyTable = Table;

/**
 * Dialect-agnostic column type.
 * Drizzle's `eq()`, `and()`, `gt()`, etc. all accept this base type.
 */
export type AnyColumn = Column;

export type Dialect = "sqlite" | "postgres" | "mysql";
