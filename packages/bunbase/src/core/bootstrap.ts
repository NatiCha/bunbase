import { getColumns, getTableName } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";

/**
 * Validate that the users table has the required columns.
 * Works with both SQLite and Postgres table definitions.
 */
export function validateUsersTable(
  schema: Record<string, unknown>,
): Table | null {
  const usersTable = Object.values(schema).find((table) => {
    if (typeof table !== "object" || table === null) return false;
    try {
      return getTableName(table as any) === "users";
    } catch {
      return false;
    }
  }) as Table | undefined;

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
      `BunBase: users table is missing required columns: ${missingDisplay.join(", ")}. ` +
        `Required columns: id, email, passwordHash (mapped to password_hash), role`,
    );
  }

  return usersTable;
}

/**
 * Extract non-internal table names from the user's schema.
 * Works with both SQLite and Postgres table definitions.
 */
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
