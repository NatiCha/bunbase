import { eq, desc } from "drizzle-orm";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { DatabaseAdapter } from "../core/adapter.ts";
import { extractAuth } from "../auth/middleware.ts";
import { createStorageDriver } from "../storage/routes.ts";
import type { StorageDriver } from "../storage/local.ts";
import { getTableName, getColumns } from "drizzle-orm";

export interface RequestLogEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId: string | null;
  timestamp: string;
}

export async function pushRequestLog(
  db: AnyDb,
  internalSchema: InternalSchema,
  entry: RequestLogEntry,
): Promise<void> {
  const logs = internalSchema.requestLogs;
  await (db as any)
    .insert(logs)
    .values({
      id: entry.id,
      method: entry.method,
      path: entry.path,
      status: entry.status,
      durationMs: entry.durationMs,
      userId: entry.userId,
      timestamp: entry.timestamp,
    })
    ;

  // Trim to 500 most recent entries — use raw SQL since subquery-based delete
  // is cleaner in raw SQL than Drizzle's API
  try {
    // Delete older entries beyond 500
    // SQLite requires LIMIT before OFFSET, so use a large limit
    const oldRows = await (db as any)
      .select({ id: logs.id })
      .from(logs)
      .orderBy(desc(logs.timestamp))
      .limit(999999)
      .offset(500)
      ;

    if (oldRows.length > 0) {
      for (const row of oldRows) {
        await (db as any).delete(logs).where(eq(logs.id, row.id));
      }
    }
  } catch {
    // Non-critical — just log trimming
  }
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: Request,
  db: AnyDb,
  internalSchema: InternalSchema,
  usersTable: any,
): Promise<{ user: Record<string, unknown> } | Response> {
  const user = await extractAuth(req, db, internalSchema, usersTable);
  if (!user) {
    return jsonError("UNAUTHORIZED", "Not authenticated", 401);
  }
  if (user.role !== "admin") {
    return jsonError("FORBIDDEN", "Admin access required", 403);
  }
  return { user };
}

// Helper: extract non-internal table names from schema
function getSchemaTableNames(schema: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null) continue;
    try {
      const name = getTableName(value as any);
      if (!name.startsWith("_")) names.add(name);
    } catch {
      // Not a Drizzle table object
    }
  }
  return names;
}

// Helper: get column definitions for a specific table
function getSchemaColumns(
  schema: Record<string, unknown>,
  tableName: string,
): Array<{ key: string; name: string; type: string; notNull: boolean; primary: boolean }> {
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null) continue;
    try {
      if (getTableName(value as any) !== tableName) continue;
      const columns = getColumns(value as any);
      return Object.entries(columns).map(([key, col]) => ({
        key,
        name: (col as any).name,
        type: (col as any).columnType,
        notNull: (col as any).notNull ?? false,
        primary: (col as any).primary ?? false,
      }));
    } catch {
      // Not a Drizzle table object
    }
  }
  return [];
}

export async function handleAdminApi(
  req: Request,
  db: AnyDb,
  adapter: DatabaseAdapter,
  internalSchema: InternalSchema,
  config: ResolvedConfig,
  schema: Record<string, unknown>,
  storage: StorageDriver,
  usersTable: any,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // Strip /_admin/api prefix to get the sub-path
  const path = pathname.slice("/_admin/api".length) || "/";

  // Auth check for all admin endpoints
  const authResult = await requireAdmin(req, db, internalSchema, usersTable);
  if (authResult instanceof Response) return authResult;

  const sessions = internalSchema.sessions;
  const oauthAccounts = internalSchema.oauthAccounts;
  const files = internalSchema.files;
  const requestLogs = internalSchema.requestLogs;
  const apiKeys = internalSchema.apiKeys;

  const qi = adapter.quoteIdentifier.bind(adapter);

  // GET /users — paginated, strips password fields
  if (path === "/users" && method === "GET") {
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const limit = 50;
    const offset = (page - 1) * limit;
    const users = await adapter.rawQuery(
      `SELECT * FROM ${qi("users")} LIMIT $limit OFFSET $offset`,
      { $limit: limit, $offset: offset },
    );
    const sanitized = users.map((u: Record<string, unknown>) => {
      const copy = { ...u };
      delete copy.password_hash;
      delete copy.passwordHash;
      return copy;
    });
    return Response.json(sanitized);
  }

  // GET /sessions
  if (path === "/sessions" && method === "GET") {
    const rows = await (db as any)
      .select()
      .from(sessions)
      .orderBy(desc(sessions.createdAt))
      ;
    return Response.json(rows);
  }

  // DELETE /sessions/:id
  const sessionDeleteMatch = path.match(/^\/sessions\/([^/]+)$/);
  if (sessionDeleteMatch && method === "DELETE") {
    const id = sessionDeleteMatch[1];
    await (db as any)
      .delete(sessions)
      .where(eq(sessions.id, id))
      ;
    return Response.json({ deleted: true });
  }

  // GET /oauth
  if (path === "/oauth" && method === "GET") {
    const rows = await (db as any)
      .select()
      .from(oauthAccounts)
      .orderBy(desc(oauthAccounts.createdAt))
      ;
    return Response.json(rows);
  }

  // GET /files
  if (path === "/files" && method === "GET") {
    const rows = await (db as any)
      .select()
      .from(files)
      .orderBy(desc(files.createdAt))
      ;
    return Response.json(rows);
  }

  // DELETE /files/:id
  const fileDeleteMatch = path.match(/^\/files\/([^/]+)$/);
  if (fileDeleteMatch && method === "DELETE") {
    const id = fileDeleteMatch[1];
    const fileRows = await (db as any)
      .select({ storagePath: files.storagePath })
      .from(files)
      .where(eq(files.id, id))
      ;

    const file = fileRows[0];
    if (!file) {
      return jsonError("NOT_FOUND", "File not found", 404);
    }

    await storage.delete(file.storagePath);
    await (db as any).delete(files).where(eq(files.id, id));
    return Response.json({ deleted: true });
  }

  // GET /logs — newest first
  if (path === "/logs" && method === "GET") {
    const rows = await (db as any)
      .select()
      .from(requestLogs)
      .orderBy(desc(requestLogs.timestamp))
      .limit(500)
      ;
    return Response.json(rows);
  }

  // DELETE /logs — clear table
  if (path === "/logs" && method === "DELETE") {
    await (db as any).delete(requestLogs);
    return Response.json({ cleared: true });
  }

  // GET /api-keys — list all API keys across all users (admin only)
  if (path === "/api-keys" && method === "GET") {
    const rows = await (db as any)
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        keyPrefix: apiKeys.keyPrefix,
        name: apiKeys.name,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt))
      ;
    return Response.json(rows);
  }

  // DELETE /api-keys/:id — revoke any key (admin only)
  const apiKeyDeleteMatch = path.match(/^\/api-keys\/([^/]+)$/);
  if (apiKeyDeleteMatch && method === "DELETE") {
    const id = apiKeyDeleteMatch[1];
    await (db as any)
      .delete(apiKeys)
      .where(eq(apiKeys.id, id))
      ;
    return Response.json({ deleted: true });
  }

  // GET /schema — table names + column definitions
  if (path === "/schema" && method === "GET") {
    const tables: Record<string, Array<{
      key: string;
      name: string;
      type: string;
      notNull: boolean;
      primary: boolean;
    }>> = {};
    for (const value of Object.values(schema)) {
      if (typeof value !== "object" || value === null) continue;
      try {
        const name = getTableName(value as any);
        const columns = getColumns(value as any);
        tables[name] = Object.entries(columns).map(([key, col]) => ({
          key,
          name: (col as any).name,
          type: (col as any).columnType,
          notNull: (col as any).notNull ?? false,
          primary: (col as any).primary ?? false,
        }));
      } catch {
        // Not a Drizzle table object
      }
    }
    return Response.json(tables);
  }

  // GET /config — sanitized (no secrets)
  if (path === "/config" && method === "GET") {
    const sanitized = {
      development: config.development,
      database: {
        driver: config.database.driver,
      },
      storage: {
        driver: config.storage.driver,
        maxFileSize: config.storage.maxFileSize,
        allowedMimeTypes: config.storage.allowedMimeTypes ?? null,
      },
      cors: config.cors,
      auth: {
        tokenExpiry: config.auth.tokenExpiry,
        hasEmail: !!config.auth.email?.webhook,
        hasGoogle: !!config.auth.oauth?.google,
        hasGithub: !!config.auth.oauth?.github,
        hasDiscord: !!config.auth.oauth?.discord,
      },
    };
    return Response.json(sanitized);
  }

  // GET /tables — list all user tables with record counts
  if (path === "/tables" && method === "GET") {
    const tableNames = getSchemaTableNames(schema);
    const result: Array<{ name: string; count: number; type: "base" | "auth" }> = [];
    for (const name of tableNames) {
      try {
        const row = await adapter.rawQueryOne<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${qi(name)}`,
        );
        result.push({ name, count: row?.count ?? 0, type: name === "users" ? "auth" : "base" });
      } catch {
        // Table might not exist yet
      }
    }
    result.sort((a, b) => {
      if (a.type === "auth" && b.type !== "auth") return -1;
      if (a.type !== "auth" && b.type === "auth") return 1;
      return a.name.localeCompare(b.name);
    });
    return Response.json(result);
  }

  // Path patterns for /records/:table and /records/:table/:id
  const recordsTableMatch = path.match(/^\/records\/([^/]+)$/);
  const recordsItemMatch = path.match(/^\/records\/([^/]+)\/([^/]+)$/);

  // GET /records/:table — paginated, searchable, sortable
  if (recordsTableMatch && method === "GET") {
    const tableName = recordsTableMatch[1];
    const validTables = getSchemaTableNames(schema);
    if (!validTables.has(tableName)) return jsonError("NOT_FOUND", `Table '${tableName}' not found. Available tables: ${Array.from(validTables).sort().join(", ")}`, 404);

    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10)));
    const offset = (page - 1) * limit;
    const search = (url.searchParams.get("search") ?? "").trim();
    const sortKey = url.searchParams.get("sort") ?? "";
    const orderDir = url.searchParams.get("order") === "desc" ? "DESC" : "ASC";

    const columns = getSchemaColumns(schema, tableName);
    const allColNames = columns.map((c) => c.name);
    const textColNames = columns
      .filter((c) => c.type.includes("Text") || c.type.includes("Varchar"))
      .map((c) => c.name);
    const sortCol = allColNames.includes(sortKey) ? sortKey : (allColNames[0] ?? "id");

    let whereClause = "";
    const queryParams: Record<string, unknown> = {};
    if (search && textColNames.length > 0) {
      const conditions = textColNames.map((col) => `${qi(col)} LIKE $search`);
      whereClause = `WHERE ${conditions.join(" OR ")}`;
      queryParams.$search = `%${search}%`;
    }

    const countRow = await adapter.rawQueryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${qi(tableName)} ${whereClause}`,
      queryParams,
    );
    const total = countRow?.count ?? 0;

    const rows = await adapter.rawQuery(
      `SELECT * FROM ${qi(tableName)} ${whereClause} ORDER BY ${qi(sortCol)} ${orderDir} LIMIT $limit OFFSET $offset`,
      { ...queryParams, $limit: limit, $offset: offset },
    );

    const sanitized = rows.map((row: Record<string, unknown>) => {
      const copy = { ...row };
      delete copy.password_hash;
      delete copy.passwordHash;
      return copy;
    });

    return Response.json({ data: sanitized, total, page, limit, totalPages: Math.ceil(total / limit) });
  }

  // POST /records/:table — create a new record
  if (recordsTableMatch && method === "POST") {
    const tableName = recordsTableMatch[1];
    const validTables = getSchemaTableNames(schema);
    if (!validTables.has(tableName)) return jsonError("NOT_FOUND", `Table '${tableName}' not found. Available tables: ${Array.from(validTables).sort().join(", ")}`, 404);

    const body = (await req.json()) as Record<string, unknown>;
    const columns = getSchemaColumns(schema, tableName);
    const now = new Date().toISOString();

    const insertData: Record<string, unknown> = {};
    for (const col of columns) {
      if (col.name === "id") {
        insertData[col.name] =
          (body[col.key] as string) ?? (body[col.name] as string) ?? Bun.randomUUIDv7();
      } else if (col.name === "created_at" || col.name === "updated_at") {
        insertData[col.name] = now;
      } else {
        const val = body[col.key] ?? body[col.name];
        if (val !== undefined) insertData[col.name] = val;
      }
    }

    if (Object.keys(insertData).length === 0) {
      return jsonError("BAD_REQUEST", "No valid fields to insert", 400);
    }

    const fieldNames = Object.keys(insertData);
    const placeholders = fieldNames.map((f) => `$${f}`);
    const params = Object.fromEntries(fieldNames.map((f) => [`$${f}`, insertData[f]]));

    await adapter.rawExecute(
      `INSERT INTO ${qi(tableName)} (${fieldNames.map((f) => qi(f)).join(", ")}) VALUES (${placeholders.join(", ")})`,
      params,
    );

    const created = await adapter.rawQueryOne(
      `SELECT * FROM ${qi(tableName)} WHERE id = $id`,
      { $id: insertData.id },
    );

    return Response.json(created, { status: 201 });
  }

  // PATCH /records/:table/:id — update a record (partial)
  if (recordsItemMatch && method === "PATCH") {
    const tableName = recordsItemMatch[1];
    const id = recordsItemMatch[2];
    const validTables = getSchemaTableNames(schema);
    if (!validTables.has(tableName)) return jsonError("NOT_FOUND", `Table '${tableName}' not found. Available tables: ${Array.from(validTables).sort().join(", ")}`, 404);

    const body = (await req.json()) as Record<string, unknown>;
    const columns = getSchemaColumns(schema, tableName);
    const colByKey = new Map(columns.map((c) => [c.key, c]));
    const colByName = new Map(columns.map((c) => [c.name, c]));
    const now = new Date().toISOString();

    const updateData: Record<string, unknown> = {};
    if (colByName.has("updated_at")) updateData.updated_at = now;

    for (const [bodyKey, value] of Object.entries(body)) {
      if (bodyKey === "id" || bodyKey === "created_at" || bodyKey === "updated_at") continue;
      const col = colByKey.get(bodyKey) ?? colByName.get(bodyKey);
      if (col) updateData[col.name] = value;
    }

    if (Object.keys(updateData).length === 0) {
      return jsonError("BAD_REQUEST", "No valid fields to update", 400);
    }

    const setClauses = Object.keys(updateData).map((f) => `${qi(f)} = $${f}`);
    const params: Record<string, unknown> = {
      ...Object.fromEntries(Object.keys(updateData).map((f) => [`$${f}`, updateData[f]])),
      $id: id,
    };

    await adapter.rawExecute(
      `UPDATE ${qi(tableName)} SET ${setClauses.join(", ")} WHERE id = $id`,
      params,
    );

    const updated = await adapter.rawQueryOne(
      `SELECT * FROM ${qi(tableName)} WHERE id = $id`,
      { $id: id },
    );

    const sanitized = { ...(updated ?? {}) };
    delete (sanitized as any).password_hash;
    delete (sanitized as any).passwordHash;
    return Response.json(sanitized);
  }

  // DELETE /records/:table/:id — delete a record
  if (recordsItemMatch && method === "DELETE") {
    const tableName = recordsItemMatch[1];
    const id = recordsItemMatch[2];
    const validTables = getSchemaTableNames(schema);
    if (!validTables.has(tableName)) return jsonError("NOT_FOUND", `Table '${tableName}' not found. Available tables: ${Array.from(validTables).sort().join(", ")}`, 404);

    await adapter.rawExecute(
      `DELETE FROM ${qi(tableName)} WHERE id = $id`,
      { $id: id },
    );
    return Response.json({ deleted: true });
  }

  return jsonError("NOT_FOUND", "Admin endpoint not found", 404);
}

export function createAdminStorage(config: ResolvedConfig): StorageDriver {
  return createStorageDriver(config);
}
