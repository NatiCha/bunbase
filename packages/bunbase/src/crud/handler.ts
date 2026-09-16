import type { Column, SQL, Table } from "drizzle-orm";
import { and, eq, getColumns, getTableName, count as sqlCount } from "drizzle-orm";
import { ApiError, errorResponse } from "../api/helpers.ts";
import type { AuthUser } from "../api/types.ts";
import type { AnyDb } from "../core/db-types.ts";
import {
  type FieldPolicy,
  type FieldPolicyMap,
  resolveFieldPolicy,
  stripHidden,
} from "../core/field-policy.ts";
import type { TableHooks } from "../hooks/types.ts";
import type { BroadcastFn } from "../realtime/manager.ts";
import { evaluateRule } from "../rules/evaluator.ts";
import type { RuleArg, TableRules } from "../rules/types.ts";
import { buildWhereConditions, type FilterInput } from "./filters.ts";
import { buildCursorCondition, buildNextCursor, buildOrderBy, resolveLimit } from "./pagination.ts";
import { buildWithClause } from "./relations.ts";

/**
 * Generated CRUD route handlers with rules, hooks, pagination, filters, and expand support.
 * @module
 */

export type RouteMap = Record<
  string,
  Record<string, (req: Request) => Response | Promise<Response>>
>;

type ExtractAuth = (req: Request) => Promise<AuthUser | null>;

function buildHookRequest(req: Request): import("../hooks/types.ts").HookRequest {
  return {
    method: req.method,
    path: new URL(req.url).pathname,
    ip:
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      null,
    headers: req.headers,
  };
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
    | Record<string, { table: Table; relations: Record<string, { targetTableName?: string }> }>
    | undefined;

  const allowed: Record<string, true> = {};
  for (const expandKey of Object.keys(withClause)) {
    const relConfig = dbRelations?.[schemaKey]?.relations?.[expandKey];
    const targetSchemaKey = relConfig?.targetTableName;
    // Drop expand keys not found in drizzle relation metadata —
    // unknown/nested keys (e.g. "owner.foo") would cause a runtime 500.
    if (!targetSchemaKey) continue;

    if (allRules) {
      // Drizzle's targetTableName is the schema export key (e.g. "projectTasks").
      // BunBase rules are keyed by SQL table name (e.g. "project_tasks").
      const targetTable = dbRelations?.[targetSchemaKey]?.table;
      if (!targetTable) continue;
      const relatedRules = allRules[getTableName(targetTable)];
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
  fieldPolicy?: FieldPolicy,
  allFields?: FieldPolicyMap,
): { exact: RouteMap; pattern: RouteMap } {
  const tableName = getTableName(table);
  const columns = getColumns(table);
  // schemaKey is the JS property name used for db.query[schemaKey]; defaults to SQL table name
  const resolvedSchemaKey = schemaKey ?? tableName;

  // Resolve the field policy (hidden / readonly / immutable) with secure defaults.
  const policy = resolveFieldPolicy(columns as Record<string, Column>, fieldPolicy);

  // Relation metadata supplies the table identity that a plain recursive JSON
  // scrubber cannot infer. Resolve policies by SQL name, including schema aliases.
  function serializeExpanded(
    row: Record<string, unknown>,
    key = resolvedSchemaKey,
    hidden = policy.hidden,
  ): Record<string, unknown> {
    const result = stripHidden(row, hidden);
    const metadata = (db as any)._?.relations;
    for (const [name, relation] of Object.entries(metadata?.[key]?.relations ?? {})) {
      if (!(name in result)) continue;
      const targetKey = (relation as { targetTableName: string }).targetTableName;
      const target = metadata?.[targetKey]?.table as Table | undefined;
      if (!target) {
        delete result[name];
        continue;
      }
      const targetPolicy = resolveFieldPolicy(
        getColumns(target) as Record<string, Column>,
        allFields?.[getTableName(target)],
      );
      const serialize = (value: unknown): unknown =>
        value && typeof value === "object"
          ? serializeExpanded(value as Record<string, unknown>, targetKey, targetPolicy.hidden)
          : value;
      result[name] = Array.isArray(row[name])
        ? (row[name] as unknown[]).map(serialize)
        : serialize(row[name]);
    }
    return result;
  }

  const idColumnMaybe = columns.id as Column | undefined;
  if (!idColumnMaybe) {
    throw new Error(`BunBase: Table "${tableName}" must have an "id" column for CRUD generation`);
  }
  const idColumn: Column = idColumnMaybe;

  const basePath = `/api/${tableName}`;
  const itemPath = `/api/${tableName}/:id`;

  // ── GET /api/{table} — list ──────────────────────────────────────────
  async function handleList(req: Request): Promise<Response> {
    const auth = await extractAuth(req);
    const ruleResult = await evaluateRule(tableRules?.list, buildRuleArg(req, auth, { db }));
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
    const rawSortField = url.searchParams.get("sort") ?? undefined;
    const order = (url.searchParams.get("order") ?? "asc") as "asc" | "desc";

    // Only allow sorting on a real, non-hidden column. Sorting on a hidden
    // column (e.g. passwordHash) is rejected so its value cannot be exfiltrated
    // via the pagination cursor.
    const sortField =
      rawSortField && rawSortField in columns && !policy.isHidden(rawSortField)
        ? rawSortField
        : undefined;
    const sortColumn = sortField ? (columns[sortField] as Column | undefined) : undefined;

    const allConditions: (SQL | undefined)[] = [];
    allConditions.push(
      buildWhereConditions(filter, columns as Record<string, Column>, policy.hidden),
    );

    if (ruleResult.whereClause) {
      allConditions.push(ruleResult.whereClause);
    }

    const filteredWhere = and(...allConditions);
    const where = and(
      filteredWhere,
      cursor ? buildCursorCondition(cursor, idColumn, sortColumn, order) : undefined,
    );

    // Optional total count (honors rules + filter where-clause) for page UIs.
    // Returned as `total` alongside the page when `?count=true`.
    let total: number | undefined;
    if (url.searchParams.get("count") === "true") {
      const countRows = await (db as any)
        .select({ value: sqlCount() })
        .from(table)
        .where(filteredWhere);
      total = Number(countRows[0]?.value ?? 0);
    }

    const orderBy = buildOrderBy(idColumn, sortColumn, order);

    // `expand` is comma-separated relation keys, e.g. `expand=owner,project.team`.
    // Keys beyond MAX_RELATION_DEPTH or unknown relation keys are dropped.
    const expandParam = url.searchParams.get("expand");
    const expandFields = expandParam
      ? expandParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const withClause = buildWithClause(expandFields);

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
      const pageIds = (rows as Record<string, unknown>[]).map((r) => String(r.id));
      if (pageIds.length > 0 && Object.keys(allowedWith).length > 0) {
        const expandedRows = await (db as any).query[resolvedSchemaKey].findMany({
          where: { OR: pageIds.map((id) => ({ id })) },
          with: allowedWith,
        });
        const expandedById = new Map<string, unknown>();
        for (const row of expandedRows) {
          expandedById.set(
            String((row as Record<string, unknown>).id),
            serializeExpanded(row as Record<string, unknown>),
          );
        }
        const enriched = pageIds.map((id) => expandedById.get(id)).filter(Boolean);
        return Response.json({ data: enriched, nextCursor, hasMore: nextCursor !== null, total });
      }
    }

    return Response.json({
      data: (rows as Record<string, unknown>[]).map((r) => stripHidden(r, policy.hidden)),
      nextCursor,
      hasMore: nextCursor !== null,
      total,
    });
  }

  // ── POST /api/{table} — create ───────────────────────────────────────
  async function handleCreate(req: Request): Promise<Response> {
    const auth = await extractAuth(req);
    const hookReq = buildHookRequest(req);

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
      // Skip columns the client may not write (hidden/readonly). This blocks
      // mass-assignment of server-controlled columns (e.g. passwordHash, or any
      // column the app marks readonly such as `role`). Hooks may still set them.
      if (!policy.isWritable(key, "create")) continue;
      const colName = (col as Column).name;
      if (key in body) {
        insertData[key] = body[key];
      } else if (colName in body) {
        insertData[key] = body[colName];
      }
    }

    // Auto-generate a UUIDv7 id when the client supplied none and the schema's
    // id column has no database/default of its own (string id columns only).
    if (
      insertData.id === undefined &&
      !(idColumn as any).hasDefault &&
      (idColumn as any).dataType === "string"
    ) {
      insertData.id = Bun.randomUUIDv7();
    }

    // beforeCreate hook
    if (tableHooks?.beforeCreate) {
      try {
        const result = await tableHooks.beforeCreate({
          data: insertData,
          auth,
          tableName,
          request: hookReq,
        });
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
    let insertError: unknown = null;
    try {
      const returning = await (db as any).insert(table).values(insertData).returning();
      createdRecord = returning[0] ?? null;
    } catch (err) {
      insertError = err;
      // MySQL doesn't support RETURNING — fall back to select by id.
      // Only attempt the fallback when the caller supplied an id; otherwise
      // we have no way to locate the row, so surface the underlying error.
      const insertedId = insertData.id ?? insertData[idColumn.name];
      if (insertedId) {
        try {
          const rows = await (db as any).select().from(table).where(eq(idColumn, insertedId));
          createdRecord = rows[0] ?? null;
        } catch (selectErr) {
          console.error(
            `[BunBase] insert RETURNING and id-fallback both failed for "${tableName}":`,
            err,
            selectErr,
          );
        }
      } else {
        console.error(
          `[BunBase] insert RETURNING failed for "${tableName}" and no id was supplied for fallback:`,
          err,
        );
      }
    }

    if (!createdRecord) {
      // Log the real driver error server-side; never echo raw SQL/constraint
      // text (which leaks table/column names) back to the client.
      if (insertError) {
        console.error(`[BunBase] insert failed for "${tableName}":`, insertError);
      }
      return errorResponse(
        "INTERNAL_SERVER_ERROR",
        insertError ? "Insert failed" : "Record was created but could not be retrieved",
        500,
      );
    }

    // afterCreate hook (errors are logged, never affect response)
    if (tableHooks?.afterCreate) {
      try {
        await tableHooks.afterCreate({ record: createdRecord, auth, tableName, request: hookReq });
      } catch (err) {
        console.error(`[BunBase] afterCreate hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "INSERT", createdRecord);

    return Response.json(stripHidden(createdRecord, policy.hidden), { status: 201 });
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
    const expandFields = expandParam
      ? expandParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
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
      return Response.json(serializeExpanded(row as Record<string, unknown>));
    }

    return Response.json(stripHidden(checkRows[0] as Record<string, unknown>, policy.hidden));
  }

  // ── PATCH /api/{table}/:id — update ─────────────────────────────────
  async function handleUpdate(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);
    const hookReq = buildHookRequest(req);

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
      // Skip columns the client may not update (hidden/readonly/immutable). This
      // blocks PATCH mass-assignment — e.g. re-keying `id`, backdating
      // `createdAt`, or escalating a readonly `role`. Hooks may still set them.
      if (!policy.isWritable(key, "update")) continue;
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
        const result = await tableHooks.beforeUpdate({
          id,
          data: filtered,
          existing: existingRecord,
          auth,
          tableName,
          request: hookReq,
        });
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

    // After write-allowlisting + hooks there may be nothing to set (e.g. the
    // client only sent readonly/immutable fields). Skip the UPDATE in that case
    // rather than letting the driver reject an empty SET.
    if (Object.keys(filtered).length > 0) {
      await (db as any).update(table).set(filtered).where(eq(idColumn, id));
    }
    const rows = await (db as any).select().from(table).where(eq(idColumn, id));
    if (rows.length === 0) return Response.json(null, { status: 404 });

    // afterUpdate hook (errors are logged, never affect response)
    if (tableHooks?.afterUpdate) {
      try {
        await tableHooks.afterUpdate({ id, record: rows[0], auth, tableName, request: hookReq });
      } catch (err) {
        console.error(`[BunBase] afterUpdate hook error for "${tableName}":`, err);
      }
    }

    broadcast?.(tableName, "UPDATE", rows[0]);

    return Response.json(stripHidden(rows[0] as Record<string, unknown>, policy.hidden));
  }

  // ── DELETE /api/{table}/:id — delete ────────────────────────────────
  async function handleDelete(req: Request): Promise<Response> {
    const id = extractIdFromUrl(req.url, tableName);
    if (!id) return errorResponse("BAD_REQUEST", "Missing id", 400);

    const auth = await extractAuth(req);
    const hookReq = buildHookRequest(req);

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
        await tableHooks.beforeDelete({
          id,
          record: existingRecord,
          auth,
          tableName,
          request: hookReq,
        });
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
        await tableHooks.afterDelete({
          id,
          record: existingRecord,
          auth,
          tableName,
          request: hookReq,
        });
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
  fields?: FieldPolicyMap,
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
      fields?.[tableName],
      fields,
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
