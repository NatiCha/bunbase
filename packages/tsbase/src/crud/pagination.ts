import { gt, lt, and, or, eq, asc, desc, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface PaginationInput {
  cursor?: string;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
}

export interface PaginationResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface CursorData {
  id: string;
  sortValue?: unknown;
}

export function encodeCursor(data: CursorData): string {
  return btoa(JSON.stringify(data));
}

export function decodeCursor(cursor: string): CursorData | null {
  try {
    const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
    if (!parsed || typeof parsed.id !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      sortValue: parsed.sortValue,
    };
  } catch {
    return null;
  }
}

export function resolveLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export function buildCursorCondition(
  cursor: string,
  idColumn: SQLiteColumn,
  sortColumn?: SQLiteColumn,
  order: "asc" | "desc" = "asc",
): SQL | undefined {
  const data = decodeCursor(cursor);
  if (!data) return undefined;

  const comparator = order === "asc" ? gt : lt;

  if (sortColumn && data.sortValue !== undefined) {
    // Tuple-equivalent cursor predicate:
    // ASC:  (sort > lastSort) OR (sort = lastSort AND id > lastId)
    // DESC: (sort < lastSort) OR (sort = lastSort AND id < lastId)
    return or(
      comparator(sortColumn, data.sortValue),
      and(eq(sortColumn, data.sortValue), comparator(idColumn, data.id)),
    );
  }

  return comparator(idColumn, data.id);
}

export function buildOrderBy(
  idColumn: SQLiteColumn,
  sortColumn?: SQLiteColumn,
  order: "asc" | "desc" = "asc",
) {
  const orderFn = order === "asc" ? asc : desc;

  if (sortColumn) {
    return [orderFn(sortColumn), orderFn(idColumn)];
  }
  return [orderFn(idColumn)];
}

export function buildNextCursor<T extends Record<string, unknown>>(
  items: T[],
  limit: number,
  sortField?: string,
): string | null {
  if (items.length < limit) return null;

  const last = items[items.length - 1];
  if (!last) return null;

  const data: CursorData = { id: String(last["id"]) };
  if (sortField && sortField !== "id") {
    data.sortValue = last[sortField];
  }
  return encodeCursor(data);
}
