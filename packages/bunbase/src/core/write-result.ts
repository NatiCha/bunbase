/** Number of rows changed by the supported Bun SQLite, PostgreSQL and MySQL drivers. */
export function affectedRows(result: unknown): number {
  if (result && typeof result === "object") {
    const value = result as { changes?: number; count?: number; affectedRows?: number };
    const count = value.changes ?? value.affectedRows ?? value.count;
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return count;
  }
  // Never accept a security-sensitive claim when the driver result is unknown.
  throw new Error("Unsupported database write result");
}
