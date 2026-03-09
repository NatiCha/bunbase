import { and, eq } from "drizzle-orm";
import type { AnyDb } from "../core/db-types.ts";
import type { StorageDriver } from "./local.ts";

/**
 * Server-side file management interface available to extend route builders.
 *
 * All operations are automatically tracked in the `_files` table, ensuring
 * every file is visible to admin/user views and accessible via `GET /files/:id`.
 *
 * This is the preferred way for extend routes to manage files — do not use
 * the raw `StorageDriver` directly, as that bypasses tracking.
 * @module
 */

export interface FileRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface FilesContext {
  /**
   * Write a file to storage and register it in `_files`.
   * Returns the file ID, which should be stored in the parent record's column.
   */
  upload(opts: {
    collection: string;
    recordId: string;
    filename: string;
    mimeType: string;
    data: Uint8Array<ArrayBufferLike>;
  }): Promise<{ id: string }>;

  /**
   * Read file bytes by file ID. Returns null if not found.
   */
  download(fileId: string): Promise<Uint8Array<ArrayBuffer> | null>;

  /**
   * Delete a file from storage and remove its `_files` record.
   */
  delete(fileId: string): Promise<void>;

  /**
   * List all files registered for a given collection + record.
   */
  list(collection: string, recordId: string): Promise<FileRecord[]>;
}

export function createFilesContext(
  db: AnyDb,
  storage: StorageDriver,
  filesTable: any,
): FilesContext {
  return {
    async upload({ collection, recordId, filename, mimeType, data }) {
      const id = crypto.randomUUID();
      const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
      const storagePath = `${collection}/${recordId}/${id}${ext}`;

      await storage.write(storagePath, data);

      await (db as any).insert(filesTable).values({
        id,
        collection,
        recordId,
        filename,
        mimeType,
        size: data.byteLength,
        storagePath,
        createdAt: new Date().toISOString(),
      });

      return { id };
    },

    async download(fileId) {
      const rows = await (db as any)
        .select()
        .from(filesTable)
        .where(eq(filesTable.id, fileId))
        .limit(1);
      const record = rows[0];
      if (!record) return null;
      return storage.read(record.storagePath);
    },

    async delete(fileId) {
      const rows = await (db as any)
        .select()
        .from(filesTable)
        .where(eq(filesTable.id, fileId))
        .limit(1);
      const record = rows[0];
      if (!record) return;
      await storage.delete(record.storagePath);
      await (db as any).delete(filesTable).where(eq(filesTable.id, fileId));
    },

    async list(collection, recordId) {
      const rows = await (db as any)
        .select()
        .from(filesTable)
        .where(and(eq(filesTable.collection, collection), eq(filesTable.recordId, recordId)));
      return rows.map((r: any) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mimeType,
        size: r.size,
        createdAt: r.createdAt,
      }));
    },
  };
}
