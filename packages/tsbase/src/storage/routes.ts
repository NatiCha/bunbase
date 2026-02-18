import type { Database } from "bun:sqlite";
import type { ResolvedConfig } from "../core/config.ts";
import type { StorageDriver } from "./local.ts";
import { createLocalStorage } from "./local.ts";
import { createS3Storage } from "./s3.ts";
import { extractAuth } from "../auth/middleware.ts";
import { evaluateRule } from "../rules/evaluator.ts";
import type { TableRules } from "../rules/types.ts";
import { and, eq, getColumns, getTableName } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import type { SQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import { extname } from "node:path";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 255);
}

interface FileRouteDeps {
  sqlite: Database;
  db: SQLiteBunDatabase;
  config: ResolvedConfig;
  schema: Record<string, unknown>;
  rules?: Record<string, TableRules>;
}

export function createStorageDriver(config: ResolvedConfig): StorageDriver {
  if (config.storage.driver === "s3" && config.storage.s3) {
    return createS3Storage(config.storage.s3);
  }
  return createLocalStorage(config.storage.localPath);
}

export function createFileRoutes(deps: FileRouteDeps) {
  const { sqlite, db, config, schema, rules } = deps;
  const storage = createStorageDriver(config);
  const collectionTables = new Map<string, SQLiteTableWithColumns<any>>();

  for (const table of Object.values(schema)) {
    if (typeof table !== "object" || table === null) {
      continue;
    }

    try {
      const tableName = getTableName(table as SQLiteTableWithColumns<any>);
      collectionTables.set(tableName, table as SQLiteTableWithColumns<any>);
    } catch {
      // Not a Drizzle table
    }
  }

  const ensureReadAccess = async (
    collection: string,
    recordId: string,
    auth: Awaited<ReturnType<typeof extractAuth>>,
  ): Promise<Response | null> => {
    const table = collectionTables.get(collection);
    if (!table) {
      return jsonError("NOT_FOUND", "Collection not found", 404);
    }

    const tableColumns = getColumns(table);
    const idColumn = tableColumns.id as SQLiteColumn | undefined;
    if (!idColumn) {
      return jsonError(
        "INTERNAL_SERVER_ERROR",
        `Collection "${collection}" is missing an id column`,
        500,
      );
    }

    const readRule = rules?.[collection]?.view ?? rules?.[collection]?.get;
    const ruleResult = await evaluateRule(readRule, {
      auth,
      id: recordId,
    });
    if (!ruleResult.allowed) {
      return jsonError("FORBIDDEN", "Access denied", 403);
    }

    const conditions = [eq(idColumn, recordId)];
    if (ruleResult.whereClause) {
      conditions.push(ruleResult.whereClause);
    }

    const where = conditions.length > 1 ? and(...conditions) : conditions[0];
    const row = db
      .select({ id: idColumn })
      .from(table)
      .where(where)
      .limit(1)
      .all();

    if (row.length === 0) {
      return jsonError("FORBIDDEN", "Access denied", 403);
    }

    return null;
  };

  return {
    "/files/:collection/:recordId": {
      async POST(req: Request): Promise<Response> {
        const user = await extractAuth(req, sqlite);
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

        const createRuleResult = await evaluateRule(rules?.[collection]?.create, {
          auth: user,
        });
        if (!createRuleResult.allowed) {
          return jsonError("FORBIDDEN", "Access denied", 403);
        }

        // Check the record exists
        try {
          const row = sqlite
            .query<{ id: string }, { $id: string }>(
              `SELECT id FROM "${collection}" WHERE id = $id`,
            )
            .get({ $id: recordId });

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

        // Save file record
        sqlite
          .query(
            `INSERT INTO _files (id, collection, record_id, filename, mime_type, size, storage_path, created_at)
             VALUES ($id, $collection, $recordId, $filename, $mimeType, $size, $storagePath, $createdAt)`,
          )
          .run({
            $id: id,
            $collection: collection,
            $recordId: recordId,
            $filename: filename,
            $mimeType: file.type,
            $size: file.size,
            $storagePath: storagePath,
            $createdAt: new Date().toISOString(),
          });

        return Response.json({
          file: {
            id,
            collection,
            recordId,
            filename,
            mimeType: file.type,
            size: file.size,
          },
        }, { status: 201 });
      },
    },

    "/files/:id": {
      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req, sqlite);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const fileId = pathParts[2];

        if (!fileId) {
          return jsonError("BAD_REQUEST", "Missing file ID", 400);
        }

        const fileRecord = sqlite
          .query<
            {
              id: string;
              collection: string;
              record_id: string;
              filename: string;
              mime_type: string;
              size: number;
              storage_path: string;
            },
            { $id: string }
          >("SELECT * FROM _files WHERE id = $id")
          .get({ $id: fileId });

        if (!fileRecord) {
          return jsonError("NOT_FOUND", "File not found", 404);
        }

        const accessError = await ensureReadAccess(
          fileRecord.collection,
          fileRecord.record_id,
          user,
        );
        if (accessError) {
          return accessError;
        }

        const data = await storage.read(fileRecord.storage_path);
        if (!data) {
          return jsonError("NOT_FOUND", "File data not found", 404);
        }

        return new Response(Uint8Array.from(data), {
          headers: {
            "Content-Type": fileRecord.mime_type,
            "Content-Disposition": `inline; filename="${fileRecord.filename}"`,
            "Content-Length": String(fileRecord.size),
          },
        });
      },

      async DELETE(req: Request): Promise<Response> {
        const user = await extractAuth(req, sqlite);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const fileId = pathParts[2];

        if (!fileId) {
          return jsonError("BAD_REQUEST", "Missing file ID", 400);
        }

        const fileRecord = sqlite
          .query<{ id: string; storage_path: string }, { $id: string }>(
            "SELECT id, storage_path FROM _files WHERE id = $id",
          )
          .get({ $id: fileId });

        if (!fileRecord) {
          return jsonError("NOT_FOUND", "File not found", 404);
        }

        const record = sqlite
          .query<{ collection: string; record_id: string }, { $id: string }>(
            "SELECT collection, record_id FROM _files WHERE id = $id",
          )
          .get({ $id: fileId });
        if (!record) {
          return jsonError("NOT_FOUND", "File not found", 404);
        }

        const deleteRuleResult = await evaluateRule(
          rules?.[record.collection]?.delete,
          {
            auth: user,
            id: record.record_id,
          },
        );
        if (!deleteRuleResult.allowed) {
          return jsonError("FORBIDDEN", "Access denied", 403);
        }

        await storage.delete(fileRecord.storage_path);
        sqlite
          .query("DELETE FROM _files WHERE id = $id")
          .run({ $id: fileId });

        return Response.json({ deleted: true });
      },
    },
  };
}

/** Delete all files associated with a record (for cascade delete) */
export function deleteRecordFiles(
  sqlite: Database,
  storage: StorageDriver,
  collection: string,
  recordId: string,
): Promise<void> {
  const files = sqlite
    .query<
      { id: string; storage_path: string },
      { $collection: string; $recordId: string }
    >(
      "SELECT id, storage_path FROM _files WHERE collection = $collection AND record_id = $recordId",
    )
    .all({ $collection: collection, $recordId: recordId });

  const deletions = files.map((file) => storage.delete(file.storage_path));
  return Promise.all(deletions).then(() => {
    sqlite
      .query(
        "DELETE FROM _files WHERE collection = $collection AND record_id = $recordId",
      )
      .run({ $collection: collection, $recordId: recordId });
  });
}
