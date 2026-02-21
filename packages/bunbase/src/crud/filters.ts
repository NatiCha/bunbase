import {
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  like,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  and,
  type SQL,
} from "drizzle-orm";
import type { Column } from "drizzle-orm";

/**
 * Filter parser and SQL condition builder for CRUD list endpoints.
 * @module
 */

/**
 * Supported operators for a single filter field.
 *
 * @example
 * { eq: "open" }
 * @example
 * { contains: "urgent" }
 * @example
 * { in: ["todo", "done"] }
 */
export interface FilterOperators {
  /** Equals. Example: `{ eq: 42 }` */
  eq?: unknown;
  /** Not equals. Example: `{ ne: "archived" }` */
  ne?: unknown;
  /** SQL `LIKE %value%`. Example: `{ contains: "foo" }` */
  contains?: string;
  /** SQL `LIKE value%`. Example: `{ startsWith: "pre" }` */
  startsWith?: string;
  /** SQL `LIKE %value`. Example: `{ endsWith: ".png" }` */
  endsWith?: string;
  /** Greater than. Example: `{ gt: 100 }` */
  gt?: unknown;
  /** Greater than or equal. Example: `{ gte: "2026-01-01" }` */
  gte?: unknown;
  /** Less than. Example: `{ lt: 10 }` */
  lt?: unknown;
  /** Less than or equal. Example: `{ lte: 5 }` */
  lte?: unknown;
  /** In list. Example: `{ in: ["a", "b"] }` */
  in?: unknown[];
  /** Not in list. Example: `{ notIn: [0, -1] }` */
  notIn?: unknown[];
  /** Null checks. `true` => IS NULL, `false` => IS NOT NULL. */
  isNull?: boolean;
}

export type FilterInput = Record<string, FilterOperators | unknown>;

/**
 * Build a combined SQL `WHERE` clause from API filter input.
 *
 * @remarks
 * - Direct primitive values are treated as `eq`.
 * - Unknown fields (not present in `columns`) are ignored.
 */
export function buildWhereConditions(
  filters: FilterInput,
  columns: Record<string, Column>,
): SQL | undefined {
  const conditions: SQL[] = [];

  for (const [fieldName, filterValue] of Object.entries(filters)) {
    const column = columns[fieldName];
    if (!column) continue;

    // Direct value means eq
    if (
      typeof filterValue !== "object" ||
      filterValue === null ||
      Array.isArray(filterValue)
    ) {
      conditions.push(eq(column, filterValue));
      continue;
    }

    const ops = filterValue as FilterOperators;

    if (ops.eq !== undefined) conditions.push(eq(column, ops.eq));
    if (ops.ne !== undefined) conditions.push(ne(column, ops.ne));
    if (ops.gt !== undefined) conditions.push(gt(column, ops.gt));
    if (ops.gte !== undefined) conditions.push(gte(column, ops.gte));
    if (ops.lt !== undefined) conditions.push(lt(column, ops.lt));
    if (ops.lte !== undefined) conditions.push(lte(column, ops.lte));

    if (ops.contains !== undefined) {
      conditions.push(like(column, `%${ops.contains}%`));
    }
    if (ops.startsWith !== undefined) {
      conditions.push(like(column, `${ops.startsWith}%`));
    }
    if (ops.endsWith !== undefined) {
      conditions.push(like(column, `%${ops.endsWith}`));
    }

    if (ops.in !== undefined && Array.isArray(ops.in)) {
      conditions.push(inArray(column, ops.in));
    }
    if (ops.notIn !== undefined && Array.isArray(ops.notIn)) {
      conditions.push(notInArray(column, ops.notIn));
    }

    if (ops.isNull === true) conditions.push(isNull(column));
    if (ops.isNull === false) conditions.push(isNotNull(column));
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}
