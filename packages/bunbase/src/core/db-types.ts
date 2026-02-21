import type { Column, Table } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { BunMySqlDatabase } from "drizzle-orm/bun-sql/mysql";

/**
 * Dialect-agnostic database type.
 * Works with SQLite (bun:sqlite + drizzle), Postgres, and MySQL (Bun.sql + drizzle).
 */
export type AnyDb = SQLiteBunDatabase | BunSQLDatabase | BunMySqlDatabase;

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
