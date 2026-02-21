import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Local filesystem storage driver and shared storage interface.
 * @module
 */

export interface StorageDriver {
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Create a local filesystem-backed storage driver rooted at `basePath`. */
export function createLocalStorage(basePath: string): StorageDriver {
  return {
    async write(path, data) {
      const fullPath = join(basePath, path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await Bun.write(fullPath, data);
    },

    async read(path) {
      const fullPath = join(basePath, path);
      const file = Bun.file(fullPath);
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },

    async delete(path) {
      const fullPath = join(basePath, path);
      try {
        unlinkSync(fullPath);
      } catch {
        // File may not exist
      }
    },

    async exists(path) {
      const fullPath = join(basePath, path);
      return Bun.file(fullPath).exists();
    },
  };
}
