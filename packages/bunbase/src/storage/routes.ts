import { extname } from "node:path";
import type { Column } from "drizzle-orm";
import { and, eq, getColumns, getTableName } from "drizzle-orm";
import { extractAuth } from "../auth/middleware.ts";
import type { DatabaseAdapter } from "../core/adapter.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import { evaluateRule } from "../rules/evaluator.ts";
import type { TableRules } from "../rules/types.ts";
import type { StorageDriver } from "./local.ts";
import { createLocalStorage } from "./local.ts";
import { createS3Storage } from "./s3.ts";

/**
 * File upload/download/delete routes and storage-driver integration.
 * @module
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 255);
}

// Extract lowercased headers and query params from a request
function extractHeadersAndQuery(req: Request): {
  headers: Record<string, string>;
  query: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const query: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => {
    query[k] = v;
  });
  return { headers, query };
}

interface FileRouteDeps {
  db: AnyDb;
  adapter: DatabaseAdapter;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  schema: Record<string, unknown>;
  rules?: Record<string, TableRules>;
  usersTable: any;
}

/** Create storage driver from resolved config (`local` or `s3`). */
export function createStorageDriver(config: ResolvedConfig): StorageDriver {
  if (config.storage.driver === "s3" && config.storage.s3) {
    return createS3Storage(config.storage.s3);
  }
  return createLocalStorage(config.storage.localPath);
}

/** Create authenticated file upload, download, and delete routes. */
export function createFileRoutes(deps: FileRouteDeps) {
  const { db, adapter, internalSchema, config, schema, rules, usersTable } = deps;
  const storage = createStorageDriver(config);
  const files = internalSchema.files;
  const collectionTables = new Map<string, any>();

  for (const table of Object.values(schema)) {
    if (typeof table !== "object" || table === null) continue;
    try {
      const tableName = getTableName(table as any);
      collectionTables.set(tableName, table);
    } catch {
      // Not a Drizzle table
    }
  }

  const ensureReadAccess = async (
    collection: string,
    recordId: string,
    auth: Awaited<ReturnType<typeof extractAuth>>,
    req: Request,
  ): Promise<Response | null> => {
    const table = collectionTables.get(collection);
    if (!table) {
      return jsonError("NOT_FOUND", "Collection not found", 404);
    }

    const tableColumns = getColumns(table);
    const idColumn = tableColumns.id as Column | undefined;
    if (!idColumn) {
      return jsonError(
        "INTERNAL_SERVER_ERROR",
        `Collection "${collection}" is missing an id column`,
        500,
      );
    }

    const { headers, query } = extractHeadersAndQuery(req);
    const readRule = rules?.[collection]?.view ?? rules?.[collection]?.get;
    const ruleResult = await evaluateRule(readRule, {
      auth,
      id: recordId,
      body: {},
      headers,
      query,
      method: req.method,
      db,
    });
    if (!ruleResult.allowed) {
      return jsonError("FORBIDDEN", "Access denied", 403);
    }

    const conditions = [eq(idColumn, recordId)];
    if (ruleResult.whereClause) {
      conditions.push(ruleResult.whereClause);
    }

    const where = conditions.length > 1 ? and(...conditions) : conditions[0];
    const row = await (db as any).select({ id: idColumn }).from(table).where(where).limit(1);

    if (row.length === 0) {
      return jsonError("FORBIDDEN", "Access denied", 403);
    }

    return null;
  };

  return {
    "/files/:collection/:recordId": {
      async POST(req: Request): Promise<Response> {
        const user = await extractAuth(req, db, internalSchema, usersTable);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        // Parse URL params from path
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const collection = pathParts[2];
        const recordId = pathParts[3];

        if (!collection || !recordId) {
          return jsonError("BAD_REQUEST", "Missing collection or recordId", 400);
        }

        if (!collectionTables.has(collection)) {
          return jsonError("NOT_FOUND", "Collection not found", 404);
        }

        const { headers, query } = extractHeadersAndQuery(req);
        const createRuleResult = await evaluateRule(rules?.[collection]?.create, {
          auth: user,
          body: {},
          headers,
          query,
          method: "POST",
          db,
        });
        if (!createRuleResult.allowed) {
          return jsonError("FORBIDDEN", "Access denied", 403);
        }

        // Check the record exists via adapter (dynamic table name)
        try {
          const row = await adapter.rawQueryOne<{ id: string }>(
            `SELECT id FROM "${collection}" WHERE id = $id`,
            { $id: recordId },
          );

          if (!row) {
            return jsonError("NOT_FOUND", "Record not found", 404);
          }
        } catch {
          return jsonError("NOT_FOUND", "Collection not found", 404);
        }

        // Parse multipart form data
        const formData = await req.formData();
        const file = formData.get("file");

        if (!file || !(file instanceof File)) {
          return jsonError("BAD_REQUEST", "No file provided", 400);
        }

        // Validate file size
        if (file.size > config.storage.maxFileSize) {
          return jsonError(
            "BAD_REQUEST",
            `File too large. Max ${config.storage.maxFileSize / (1024 * 1024)}MB`,
            400,
          );
        }

        // Validate MIME type
        if (config.storage.allowedMimeTypes) {
          if (!config.storage.allowedMimeTypes.includes(file.type)) {
            return jsonError("BAD_REQUEST", "File type not allowed", 400);
          }
        }

        const id = Bun.randomUUIDv7();
        const filename = sanitizeFilename(file.name);
        const ext = extname(filename);
        const storagePath = `${collection}/${recordId}/${id}${ext}`;

        // Write file to storage
        const data = new Uint8Array(await file.arrayBuffer());
        await storage.write(storagePath, data);

        // Save file record via Drizzle
        await (db as any).insert(files).values({
          id,
          collection,
          recordId,
          filename,
          mimeType: file.type,
          size: file.size,
          storagePath,
          createdAt: new Date().toISOString(),
        });

        return Response.json(
          {
            file: {
              id,
              collection,
              recordId,
              filename,
              mimeType: file.type,
              size: file.size,
            },
          },
          { status: 201 },
        );
      },
    },

    "/files/:id": {
      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req, db, internalSchema, usersTable);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const fileId = pathParts[2];

        if (!fileId) {
          return jsonError("BAD_REQUEST", "Missing file ID", 400);
        }

        const fileRows = await (db as any).select().from(files).where(eq(files.id, fileId));

        const fileRecord = fileRows[0];
        if (!fileRecord) {
          return jsonError("NOT_FOUND", "File not found", 404);
        }

        const accessError = await ensureReadAccess(
          fileRecord.collection,
          fileRecord.recordId,
          user,
          req,
        );
        if (accessError) {
          return accessError;
        }

        const data = await storage.read(fileRecord.storagePath);
        if (!data) {
          return jsonError("NOT_FOUND", "File data not found", 404);
        }

        return new Response(Uint8Array.from(data), {
          headers: {
            "Content-Type": fileRecord.mimeType,
            "Content-Disposition": `attachment; filename="${fileRecord.filename}"`,
            "Content-Length": String(fileRecord.size),
            "X-Content-Type-Options": "nosniff",
          },
        });
      },

      async DELETE(req: Request): Promise<Response> {
        const user = await extractAuth(req, db, internalSchema, usersTable);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const fileId = pathParts[2];

        if (!fileId) {
          return jsonError("BAD_REQUEST", "Missing file ID", 400);
        }

        const fileRows = await (db as any).select().from(files).where(eq(files.id, fileId));

        const fileRecord = fileRows[0];
        if (!fileRecord) {
          return jsonError("NOT_FOUND", "File not found", 404);
        }

        const { headers, query } = extractHeadersAndQuery(req);
        const deleteRuleResult = await evaluateRule(rules?.[fileRecord.collection]?.delete, {
          auth: user,
          id: fileRecord.recordId,
          body: {},
          headers,
          query,
          method: "DELETE",
          db,
        });
        if (!deleteRuleResult.allowed) {
          return jsonError("FORBIDDEN", "Access denied", 403);
        }

        await storage.delete(fileRecord.storagePath);
        await (db as any).delete(files).where(eq(files.id, fileId));

        return Response.json({ deleted: true });
      },
    },
  };
}

/** Delete all files associated with a record (for cascade delete) */
export async function deleteRecordFiles(
  db: AnyDb,
  internalSchema: InternalSchema,
  storage: StorageDriver,
  collection: string,
  recordId: string,
): Promise<void> {
  const files = internalSchema.files;
  const fileRows = await (db as any)
    .select({ id: files.id, storagePath: files.storagePath })
    .from(files)
    .where(and(eq(files.collection, collection), eq(files.recordId, recordId)));

  const deletions = fileRows.map((file: any) => storage.delete(file.storagePath));
  await Promise.all(deletions);

  await (db as any)
    .delete(files)
    .where(and(eq(files.collection, collection), eq(files.recordId, recordId)));
}
