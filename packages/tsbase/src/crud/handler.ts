import { getColumns, getTableName, eq, and } from "drizzle-orm";
import type { SQL, Column, Table } from "drizzle-orm";
import { buildWhereConditions, type FilterInput } from "./filters.ts";
import {
  resolveLimit,
  buildCursorCondition,
  buildOrderBy,
  buildNextCursor,
} from "./pagination.ts";
import { evaluateRule } from "../rules/evaluator.ts";
import type { TableRules } from "../rules/types.ts";
import type { TableHooks } from "../hooks/types.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { AuthUser } from "../api/types.ts";
import { errorResponse, ApiError } from "../api/helpers.ts";
import type { BroadcastFn } from "../realtime/manager.ts";

export type RouteMap = Record<
  string,
  Record<string, (req: Request) => Response | Promise<Response>>
>;

type ExtractAuth = (req: Request) => Promise<AuthUser | null>;

export function generateCrudHandlers(
  table: Table,
  db: AnyDb,
  extractAuth: ExtractAuth,
  tableRules?: TableRules,
  tableHooks?: TableHooks,
  broadcast?: BroadcastFn,
): { exact: RouteMap; pattern: RouteMap } {
  const tableName = getTableName(table);
  const columns = getColumns(table);

  const idColumn = columns["id"] as Column | undefined;
  if (!idColumn) {
    throw new Error(
      `TSBase: Table "${tableName}" must have an "id" column for CRUD generation`,
    );
  }

  const basePath = `/api/${tableName}`;
  const itemPath = `/api/${tableName}/:id`;

  // ── GET /api/{table} — list ──────────────────────────────────────────
  async function handleList(req: Request): Promise<Response> {
    const auth = await extractAuth(req);
    const ruleResult = await evaluateRule(tableRules?.list, { auth });
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    const url = new URL(req.url);
    let filter: FilterInput = {};
    try {
      const raw = url.searchParams.get("filter");
      if (raw) filter = JSON.parse(raw) as FilterInput;
    } catch {
      return errorResponse("BAD_REQUEST", "Invalid filter JSON", 400);
    }
    const limitParam = url.searchParams.get("limit");
    const limit = resolveLimit(limitParam ? Number(limitParam) : undefined);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const sortField = url.searchParams.get("sort") ?? undefined;
    const order = (url.searchParams.get("order") ?? "asc") as "asc" | "desc";

    const sortColumn = sortField
      ? (columns[sortField] as Column | undefined)
      : undefined;

    const allConditions: (SQL | undefined)[] = [];
    allConditions.push(buildWhereConditions(filter, columns as Record<string, Column>));

    if (cursor) {
      allConditions.push(buildCursorCondition(cursor, idColumn, sortColumn, order));
    }

    if (ruleResult.whereClause) {
      allConditions.push(ruleResult.whereClause);
    }

    const conditions = allConditions.filter(Boolean) as SQL[];
    const where =
      conditions.length > 1 ? and(...conditions) : conditions[0] ?? undefined;

    const orderBy = buildOrderBy(idColumn, sortColumn, order);

    const rows = await (db as any)
      .select()
      .from(table)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit);

    const nextCursor = buildNextCursor(rows, limit, sortField);
    return Response.json({ data: rows, nextCursor, hasMore: nextCursor !== null });
  }

  // ── POST /api/{table} — create ───────────────────────────────────────
  async function handleCreate(req: Request): Promise<Response> {
    const auth = await extractAuth(req);
    const ruleResult = await evaluateRule(tableRules?.create, { auth });
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
    }

    let insertData: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(columns)) {
      const colName = (col as Column).name;
      if (key in body) {
        insertData[key] = body[key];
      } else if (colName in body) {
        insertData[key] = body[colName];
      }
    }

    // beforeCreate hook
    if (tableHooks?.beforeCreate) {
      try {
        const result = await tableHooks.beforeCreate({ data: insertData, auth, tableName });
        if (result !== undefined && result !== null) {
          insertData = result as Record<string, unknown>;
        }
      } catch (err) {
        if (err instanceof ApiError) {
          return errorResponse(err.code, err.message, err.status);
        }
        console.error(`[TSBase] beforeCreate hook error for "${tableName}":`, err);
        return errorResponse("HOOK_ERROR", "An error occurred in beforeCreate hook", 500);
      }
    }

    let createdRecord: Record<string, unknown> | null = null;
    try {
      const returning = await (db as any)
        .insert(table)
        .values(insertData)
        .returning();
      createdRecord = returning[0] ?? null;
    } catch {
      // MySQL doesn't support RETURNING — fall back to select by id
      const insertedId = insertData["id"] ?? insertData[idColumn.name];
      if (insertedId) {
        const rows = await (db as any)
          .select()
          .from(table)
          .where(eq(idColumn, insertedId));
        createdRecord = rows[0] ?? null;
      }
    }

    if (!createdRecord) {
      return errorResponse("INTERNAL_SERVER_ERROR", "Record was created but could not be retrieved", 500);
    }

    // afterCreate hook (errors are logged, never affect response)
    if (tableHooks?.afterCreate) {
      try {
        await tableHooks.afterCreate({ record: createdRecord, auth, tableName });
      } catch (err) {
        console.error(`[TSBase] afterCreate hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "INSERT", createdRecord);

    return Response.json(createdRecord, { status: 201 });
  }

  // ── GET /api/{table}/:id — get ───────────────────────────────────────
  async function handleGet(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);
    const readRule = tableRules?.view ?? tableRules?.get;
    const ruleResult = await evaluateRule(readRule, { auth, id });
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    const conditions: SQL[] = [eq(idColumn, id)];
    if (ruleResult.whereClause) conditions.push(ruleResult.whereClause);
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];

    const rows = await (db as any).select().from(table).where(where);
    const row = rows[0];
    if (!row) return Response.json(null, { status: 404 });
    return Response.json(row);
  }

  // ── PATCH /api/{table}/:id — update ─────────────────────────────────
  async function handleUpdate(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);
    const ruleResult = await evaluateRule(tableRules?.update, { auth, id });
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    if (ruleResult.whereClause) {
      const check = await (db as any)
        .select()
        .from(table)
        .where(and(eq(idColumn, id), ruleResult.whereClause));
      if (check.length === 0) {
        return errorResponse("FORBIDDEN", "Access denied", 403);
      }
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
    }

    let filtered: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(columns)) {
      const colName = (col as Column).name;
      if (key in body) {
        filtered[key] = body[key];
      } else if (colName in body) {
        filtered[key] = body[colName];
      }
    }

    // beforeUpdate hook — pre-fetch existing record; 404 early if missing
    if (tableHooks?.beforeUpdate) {
      const existingRows = await (db as any).select().from(table).where(eq(idColumn, id));
      if (existingRows.length === 0) return Response.json(null, { status: 404 });
      const existing = existingRows[0];
      try {
        const result = await tableHooks.beforeUpdate({ id, data: filtered, existing, auth, tableName });
        if (result !== undefined && result !== null) {
          filtered = result as Record<string, unknown>;
        }
      } catch (err) {
        if (err instanceof ApiError) {
          return errorResponse(err.code, err.message, err.status);
        }
        console.error(`[TSBase] beforeUpdate hook error for "${tableName}":`, err);
        return errorResponse("HOOK_ERROR", "An error occurred in beforeUpdate hook", 500);
      }
    }

    await (db as any).update(table).set(filtered).where(eq(idColumn, id));
    const rows = await (db as any).select().from(table).where(eq(idColumn, id));
    if (rows.length === 0) return Response.json(null, { status: 404 });

    // afterUpdate hook (errors are logged, never affect response)
    if (tableHooks?.afterUpdate) {
      try {
        await tableHooks.afterUpdate({ id, record: rows[0], auth, tableName });
      } catch (err) {
        console.error(`[TSBase] afterUpdate hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "UPDATE", rows[0]);

    return Response.json(rows[0]);
  }

  // ── DELETE /api/{table}/:id — delete ────────────────────────────────
  async function handleDelete(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);
    const ruleResult = await evaluateRule(tableRules?.delete, { auth, id });
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    if (ruleResult.whereClause) {
      const check = await (db as any)
        .select()
        .from(table)
        .where(and(eq(idColumn, id), ruleResult.whereClause));
      if (check.length === 0) {
        return errorResponse("FORBIDDEN", "Access denied", 403);
      }
    }

    const rows = await (db as any).select().from(table).where(eq(idColumn, id));
    if (rows.length === 0) return Response.json({ deleted: false });

    // beforeDelete hook
    if (tableHooks?.beforeDelete) {
      try {
        await tableHooks.beforeDelete({ id, record: rows[0], auth, tableName });
      } catch (err) {
        if (err instanceof ApiError) {
          return errorResponse(err.code, err.message, err.status);
        }
        console.error(`[TSBase] beforeDelete hook error for "${tableName}":`, err);
        return errorResponse("HOOK_ERROR", "An error occurred in beforeDelete hook", 500);
      }
    }

    await (db as any).delete(table).where(eq(idColumn, id));

    // afterDelete hook (errors are logged, never affect response)
    if (tableHooks?.afterDelete) {
      try {
        await tableHooks.afterDelete({ id, record: rows[0], auth, tableName });
      } catch (err) {
        console.error(`[TSBase] afterDelete hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "DELETE", rows[0]);

    return Response.json({ deleted: true });
  }

  const exact: RouteMap = {
    [basePath]: {
      GET: handleList,
      POST: handleCreate,
    },
  };

  const pattern: RouteMap = {
    [itemPath]: {
      GET: handleGet,
      PATCH: handleUpdate,
      DELETE: handleDelete,
    },
  };

  return { exact, pattern };
}

export function generateAllCrudHandlers(
  schema: Record<string, unknown>,
  db: AnyDb,
  extractAuth: ExtractAuth,
  rules?: Record<string, TableRules>,
  hooks?: Record<string, TableHooks>,
  broadcast?: BroadcastFn,
): { exact: RouteMap; pattern: RouteMap } {
  const exact: RouteMap = {};
  const pattern: RouteMap = {};

  for (const [, table] of Object.entries(schema)) {
    if (typeof table !== "object" || table === null) continue;

    let tableName: string;
    try {
      tableName = getTableName(table as any);
    } catch {
      continue;
    }

    if (tableName.startsWith("_")) continue;

    const handlers = generateCrudHandlers(
      table as Table,
      db,
      extractAuth,
      rules?.[tableName],
      hooks?.[tableName],
      broadcast,
    );

    Object.assign(exact, handlers.exact);
    Object.assign(pattern, handlers.pattern);
  }

  return { exact, pattern };
}

function extractIdFromUrl(urlStr: string, tableName: string): string | null {
  const url = new URL(urlStr);
  const prefix = `/api/${tableName}/`;
  if (url.pathname.startsWith(prefix)) {
    return url.pathname.slice(prefix.length) || null;
  }
  return null;
}
