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

export interface FilterOperators {
  eq?: unknown;
  ne?: unknown;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
  in?: unknown[];
  notIn?: unknown[];
  isNull?: boolean;
}

export type FilterInput = Record<string, FilterOperators | unknown>;

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
