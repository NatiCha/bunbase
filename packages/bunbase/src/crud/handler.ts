import { getColumns, getTableName, eq, and } from "drizzle-orm";
import type { SQL, Column, Table } from "drizzle-orm";
import { buildWhereConditions, type FilterInput } from "./filters.ts";
import {
  resolveLimit,
  buildCursorCondition,
  buildOrderBy,
  buildNextCursor,
} from "./pagination.ts";
import { buildWithClause } from "./relations.ts";
import { evaluateRule } from "../rules/evaluator.ts";
import type { TableRules } from "../rules/types.ts";
import type { RuleArg } from "../rules/types.ts";
import type { TableHooks } from "../hooks/types.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { AuthUser } from "../api/types.ts";
import { errorResponse, ApiError } from "../api/helpers.ts";
import type { BroadcastFn } from "../realtime/manager.ts";

/**
 * Generated CRUD route handlers with rules, hooks, pagination, filters, and expand support.
 * @module
 */

export type RouteMap = Record<
  string,
  Record<string, (req: Request) => Response | Promise<Response>>
>;

type ExtractAuth = (req: Request) => Promise<AuthUser | null>;

// Strip the auth-internal passwordHash field from any record returned by the API.
// This field is managed by BunBase's auth system and must never appear in responses,
// regardless of table rules. Recurses into nested objects and arrays (many-relations).
function stripSensitiveFields(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (key === "passwordHash") continue;
    if (Array.isArray(val)) {
      result[key] = val.map((item) =>
        item !== null && typeof item === "object"
          ? stripSensitiveFields(item as Record<string, unknown>)
          : item,
      );
    } else if (val !== null && typeof val === "object") {
      result[key] = stripSensitiveFields(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// Build a RuleArg from a request, auth, and optional extras.
function buildRuleArg(
  req: Request,
  auth: AuthUser | null,
  extras: {
    id?: string;
    body?: Record<string, unknown>;
    record?: Record<string, unknown>;
    db: AnyDb;
  },
): RuleArg {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return {
    auth,
    id: extras.id,
    body: extras.body ?? {},
    record: extras.record,
    headers,
    query,
    method: req.method,
    db: extras.db,
  };
}

// Given a db._.relations config, resolve which expand keys are allowed for the
// current user given the full rules map. Returns a filtered withClause
// containing only the expand fields whose target table's list rule permits access.
// Unknown keys (not in drizzle metadata) are always dropped to prevent runtime errors.
// Keys whose target table list rule returns a SQL whereClause are also dropped —
// filtered rules cannot be applied to nested expand queries.
async function resolveAllowedWithClause(
  withClause: Record<string, true>,
  schemaKey: string,
  db: AnyDb,
  allRules: Record<string, TableRules> | undefined,
  auth: AuthUser | null,
): Promise<Record<string, true>> {
  const dbRelations = (db as any)._?.relations as
    | Record<string, { relations: Record<string, { targetTableName?: string }> }>
    | undefined;

  const allowed: Record<string, true> = {};
  for (const expandKey of Object.keys(withClause)) {
    const relConfig = dbRelations?.[schemaKey]?.relations?.[expandKey];
    const targetTableName = relConfig?.targetTableName;
    // Drop expand keys not found in drizzle relation metadata —
    // unknown/nested keys (e.g. "owner.foo") would cause a runtime 500.
    if (!targetTableName) continue;

    if (allRules) {
      const relatedRules = allRules[targetTableName];
      const result = await evaluateRule(relatedRules?.list, {
        auth,
        body: {},
        headers: {},
        query: {},
        method: "GET",
        db,
      });
      // Deny if the rule explicitly denies, OR if it returns a SQL whereClause:
      // filtered list rules can't be applied to nested expand queries, so we treat
      // any row-level filter on the related table as a denial for expand.
      if (!result.allowed || result.whereClause) continue;
    }

    allowed[expandKey] = true;
  }
  return allowed;
}

export function generateCrudHandlers(
  table: Table,
  db: AnyDb,
  extractAuth: ExtractAuth,
  tableRules?: TableRules,
  tableHooks?: TableHooks,
  broadcast?: BroadcastFn,
  schemaKey?: string,
  allRules?: Record<string, TableRules>,
): { exact: RouteMap; pattern: RouteMap } {
  const tableName = getTableName(table);
  const columns = getColumns(table);
  // schemaKey is the JS property name used for db.query[schemaKey]; defaults to SQL table name
  const resolvedSchemaKey = schemaKey ?? tableName;

  const idColumn = columns["id"] as Column | undefined;
  if (!idColumn) {
    throw new Error(
      `BunBase: Table "${tableName}" must have an "id" column for CRUD generation`,
    );
  }

  const basePath = `/api/${tableName}`;
  const itemPath = `/api/${tableName}/:id`;

  // ── GET /api/{table} — list ──────────────────────────────────────────
  async function handleList(req: Request): Promise<Response> {
    const auth = await extractAuth(req);
    const ruleResult = await evaluateRule(
      tableRules?.list,
      buildRuleArg(req, auth, { db }),
    );
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
    const fetchAll = limit === -1;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const sortField = url.searchParams.get("sort") ?? undefined;
    const order = (url.searchParams.get("order") ?? "asc") as "asc" | "desc";

    const sortColumn = sortField
      ? (columns[sortField] as Column | undefined)
      : undefined;

    const allConditions: (SQL | undefined)[] = [];
    allConditions.push(buildWhereConditions(filter, columns as Record<string, Column>));

    if (cursor && !fetchAll) {
      allConditions.push(buildCursorCondition(cursor, idColumn, sortColumn, order));
    }

    if (ruleResult.whereClause) {
      allConditions.push(ruleResult.whereClause);
    }

    const conditions = allConditions.filter(Boolean) as SQL[];
    const where =
      conditions.length > 1 ? and(...conditions) : conditions[0] ?? undefined;

    const orderBy = buildOrderBy(idColumn, sortColumn, order);

    // `expand` is comma-separated relation keys, e.g. `expand=owner,project.team`.
    // Keys beyond MAX_RELATION_DEPTH or unknown relation keys are dropped.
    const expandParam = url.searchParams.get("expand");
    const expandFields = expandParam ? expandParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const withClause = buildWithClause(expandFields);

    // fetchAll branch: limit=-1 sentinel — return all rows without a LIMIT clause.
    // IDs are chunked in batches of 500 for the expand query to stay within
    // SQLite's SQLITE_LIMIT_VARIABLE_NUMBER (default 999).
    if (fetchAll) {
      const allRows = await (db as any)
        .select()
        .from(table)
        .where(where)
        .orderBy(...orderBy);

      if (withClause && Object.keys(withClause).length > 0) {
        if (!(db as any).query?.[resolvedSchemaKey]) {
          return errorResponse(
            "BAD_REQUEST",
            `expand is not supported for table "${tableName}" — ensure defineRelations() is passed to createServer()`,
            400,
          );
        }
        const allowedWith = await resolveAllowedWithClause(
          withClause,
          resolvedSchemaKey,
          db,
          allRules,
          auth,
        );
        const allIds = (allRows as Record<string, unknown>[]).map((r) => String(r["id"]));
        const expandedById = new Map<string, unknown>();
        for (let i = 0; i < allIds.length; i += 500) {
          const batchIds = allIds.slice(i, i + 500);
          const batchRows = await (db as any).query[resolvedSchemaKey].findMany({
            where: { OR: batchIds.map((id) => ({ id })) },
            with: allowedWith,
          });
          for (const row of batchRows) {
            expandedById.set(
              String((row as Record<string, unknown>)["id"]),
              stripSensitiveFields(row as Record<string, unknown>),
            );
          }
        }
        const enriched = allIds.map((id) => expandedById.get(id)).filter(Boolean);
        return Response.json({ data: enriched, nextCursor: null, hasMore: false });
      }

      return Response.json({
        data: (allRows as Record<string, unknown>[]).map(stripSensitiveFields),
        nextCursor: null,
        hasMore: false,
      });
    }

    // Step 1: Fetch paginated rows using standard SQL (handles all WHERE/ORDER/LIMIT conditions)
    const rows = await (db as any)
      .select()
      .from(table)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit);

    const nextCursor = buildNextCursor(rows as Record<string, unknown>[], limit, sortField);

    // Step 2: If expand requested, enrich the page rows with relational data
    if (withClause) {
      if (!(db as any).query?.[resolvedSchemaKey]) {
        return errorResponse(
          "BAD_REQUEST",
          `expand is not supported for table "${tableName}" — ensure defineRelations() is passed to createServer()`,
          400,
        );
      }
      // Check each expanded relation's target table against that table's list rule.
      // If denied, the expand key is silently dropped (no data leak).
      const allowedWith = await resolveAllowedWithClause(
        withClause,
        resolvedSchemaKey,
        db,
        allRules,
        auth,
      );
      const pageIds = (rows as Record<string, unknown>[]).map((r) => String(r["id"]));
      if (pageIds.length > 0 && Object.keys(allowedWith).length > 0) {
        const expandedRows = await (db as any).query[resolvedSchemaKey].findMany({
          where: { OR: pageIds.map((id) => ({ id })) },
          with: allowedWith,
        });
        const expandedById = new Map<string, unknown>();
        for (const row of expandedRows) {
          expandedById.set(
            String((row as Record<string, unknown>)["id"]),
            stripSensitiveFields(row as Record<string, unknown>),
          );
        }
        const enriched = pageIds.map((id) => expandedById.get(id)).filter(Boolean);
        return Response.json({ data: enriched, nextCursor, hasMore: nextCursor !== null });
      }
    }

    return Response.json({
      data: (rows as Record<string, unknown>[]).map(stripSensitiveFields),
      nextCursor,
      hasMore: nextCursor !== null,
    });
  }

  // ── POST /api/{table} — create ───────────────────────────────────────
  async function handleCreate(req: Request): Promise<Response> {
    const auth = await extractAuth(req);

    // Parse body BEFORE rule eval so rules can inspect it
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
    }

    const ruleResult = await evaluateRule(
      tableRules?.create,
      buildRuleArg(req, auth, { body, db }),
    );
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
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
        console.error(`[BunBase] beforeCreate hook error for "${tableName}":`, err);
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
        console.error(`[BunBase] afterCreate hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "INSERT", createdRecord);

    return Response.json(stripSensitiveFields(createdRecord), { status: 201 });
  }

  // ── GET /api/{table}/:id — get ───────────────────────────────────────
  async function handleGet(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);
    const readRule = tableRules?.view ?? tableRules?.get;
    const ruleResult = await evaluateRule(readRule, buildRuleArg(req, auth, { id, db }));
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    const conditions: SQL[] = [eq(idColumn, id)];
    if (ruleResult.whereClause) conditions.push(ruleResult.whereClause);
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];

    const url = new URL(req.url);
    // `expand` syntax: comma-separated relation keys (dotted nesting allowed up to depth limit).
    const expandParam = url.searchParams.get("expand");
    const expandFields = expandParam ? expandParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const withClause = buildWithClause(expandFields);

    // Verify record exists and is accessible (handles rule whereClause correctly)
    const checkRows = await (db as any).select().from(table).where(where);
    if (!checkRows[0]) return Response.json(null, { status: 404 });

    if (withClause) {
      if (!(db as any).query?.[resolvedSchemaKey]) {
        return errorResponse(
          "BAD_REQUEST",
          `expand is not supported for table "${tableName}" — ensure defineRelations() is passed to createServer()`,
          400,
        );
      }
      // Check each expanded relation's target table against that table's list rule.
      const allowedWith = await resolveAllowedWithClause(
        withClause,
        resolvedSchemaKey,
        db,
        allRules,
        auth,
      );
      // RQB where only accepts plain object filters, not SQL expressions
      // Access already verified by the select above (step 1).
      const row = await (db as any).query[resolvedSchemaKey].findFirst({
        where: { id },
        with: allowedWith,
      });
      if (!row) return Response.json(null, { status: 404 });
      return Response.json(stripSensitiveFields(row as Record<string, unknown>));
    }

    return Response.json(stripSensitiveFields(checkRows[0] as Record<string, unknown>));
  }

  // ── PATCH /api/{table}/:id — update ─────────────────────────────────
  async function handleUpdate(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);

    // Parse body before rule eval so rules can inspect it
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("BAD_REQUEST", "Invalid JSON body", 400);
    }

    // Fetch existing record for rule context (may be undefined if not found)
    const existingRows = await (db as any).select().from(table).where(eq(idColumn, id));
    const existingRecord: Record<string, unknown> | undefined = existingRows[0] ?? undefined;

    const ruleResult = await evaluateRule(
      tableRules?.update,
      buildRuleArg(req, auth, { id, body, record: existingRecord, db }),
    );
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    // Existence check AFTER rule denial (avoids leaking existence via 403 vs 404)
    if (existingRecord === undefined) {
      return Response.json(null, { status: 404 });
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

    let filtered: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(columns)) {
      const colName = (col as Column).name;
      if (key in body) {
        filtered[key] = body[key];
      } else if (colName in body) {
        filtered[key] = body[colName];
      }
    }

    // beforeUpdate hook — share already-fetched existing record (no duplicate fetch)
    if (tableHooks?.beforeUpdate) {
      try {
        const result = await tableHooks.beforeUpdate({ id, data: filtered, existing: existingRecord, auth, tableName });
        if (result !== undefined && result !== null) {
          filtered = result as Record<string, unknown>;
        }
      } catch (err) {
        if (err instanceof ApiError) {
          return errorResponse(err.code, err.message, err.status);
        }
        console.error(`[BunBase] beforeUpdate hook error for "${tableName}":`, err);
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
        console.error(`[BunBase] afterUpdate hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "UPDATE", rows[0]);

    return Response.json(stripSensitiveFields(rows[0] as Record<string, unknown>));
  }

  // ── DELETE /api/{table}/:id — delete ────────────────────────────────
  async function handleDelete(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);

    // Fetch existing record for rule context (may be undefined if not found)
    const existingRows = await (db as any).select().from(table).where(eq(idColumn, id));
    const existingRecord: Record<string, unknown> | undefined = existingRows[0] ?? undefined;

    const ruleResult = await evaluateRule(
      tableRules?.delete,
      buildRuleArg(req, auth, { id, record: existingRecord, db }),
    );
    if (!ruleResult.allowed) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }

    // Existence check AFTER rule denial (avoids leaking existence via 403 vs 404)
    if (existingRecord === undefined) {
      return Response.json({ deleted: false });
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

    // beforeDelete hook — share already-fetched record (no duplicate fetch)
    if (tableHooks?.beforeDelete) {
      try {
        await tableHooks.beforeDelete({ id, record: existingRecord, auth, tableName });
      } catch (err) {
        if (err instanceof ApiError) {
          return errorResponse(err.code, err.message, err.status);
        }
        console.error(`[BunBase] beforeDelete hook error for "${tableName}":`, err);
        return errorResponse("HOOK_ERROR", "An error occurred in beforeDelete hook", 500);
      }
    }

    await (db as any).delete(table).where(eq(idColumn, id));

    // afterDelete hook (errors are logged, never affect response)
    if (tableHooks?.afterDelete) {
      try {
        await tableHooks.afterDelete({ id, record: existingRecord, auth, tableName });
      } catch (err) {
        console.error(`[BunBase] afterDelete hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "DELETE", existingRecord);

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

  for (const [schemaKey, table] of Object.entries(schema)) {
    if (typeof table !== "object" || table === null) continue;

    let tableName: string;
    try {
      tableName = getTableName(table as any);
      if (!tableName || tableName.startsWith("_")) continue;
    } catch {
      continue;
    }

    const handlers = generateCrudHandlers(
      table as Table,
      db,
      extractAuth,
      rules?.[tableName],
      hooks?.[tableName],
      broadcast,
      schemaKey,
      rules,
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
