import type { Column } from "drizzle-orm";
import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";

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
  // NOTE: the `-1` listAll sentinel is intentionally NOT honored from client
  // input — exposing it let any list-permitted caller dump an entire table.
  // Non-positive / NaN / unbounded values clamp to the default, and the upper
  // bound is always MAX_LIMIT.
  if (!limit || Number.isNaN(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export function buildCursorCondition(
  cursor: string,
  idColumn: Column,
  sortColumn?: Column,
  order: "asc" | "desc" = "asc",
): SQL | undefined {
  const data = decodeCursor(cursor);
  if (!data) return undefined;

  const comparator = order === "asc" ? gt : lt;

  if (sortColumn && data.sortValue !== undefined) {
    // JSON cursors serialize Date values to ISO strings. Restore the column's
    // input type before Drizzle invokes its timestamp encoder on the next page.
    let sortValue = data.sortValue;
    if (sortColumn.dataType === "object date" && typeof sortValue === "string") {
      const date = new Date(sortValue);
      if (Number.isNaN(date.getTime())) return undefined;
      sortValue = date;
    }
    // Tuple-equivalent cursor predicate:
    // ASC:  (sort > lastSort) OR (sort = lastSort AND id > lastId)
    // DESC: (sort < lastSort) OR (sort = lastSort AND id < lastId)
    return or(
      comparator(sortColumn, sortValue),
      and(eq(sortColumn, sortValue), comparator(idColumn, data.id)),
    );
  }

  return comparator(idColumn, data.id);
}

export function buildOrderBy(idColumn: Column, sortColumn?: Column, order: "asc" | "desc" = "asc") {
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

  const data: CursorData = { id: String(last.id) };
  if (sortField && sortField !== "id") {
    data.sortValue = last[sortField];
  }
  return encodeCursor(data);
}
