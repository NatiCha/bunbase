import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Local filesystem storage driver and shared storage interface.
 * @module
 */

export interface StorageDriver {
  write(path: string, data: Uint8Array<ArrayBufferLike>): Promise<void>;
  read(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Create a local filesystem-backed storage driver rooted at `basePath`. */
export function createLocalStorage(basePath: string): StorageDriver {
  const root = resolve(basePath);

  /**
   * Resolve a caller-supplied key against the storage root and assert the
   * result stays inside it. Defense-in-depth: storage keys are server-built
   * today, but this guarantees a `..`-laden key can never escape the upload
   * directory and read/write/delete arbitrary files.
   */
  function safeJoin(path: string): string {
    const fullPath = resolve(join(root, path));
    if (fullPath !== root && !fullPath.startsWith(root + sep)) {
      throw new Error("Invalid storage path: escapes storage root");
    }
    return fullPath;
  }

  return {
    async write(path: string, data: Uint8Array<ArrayBufferLike>) {
      const fullPath = safeJoin(path);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      await Bun.write(fullPath, data);
    },

    async read(path) {
      const fullPath = safeJoin(path);
      const file = Bun.file(fullPath);
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },

    async delete(path) {
      const fullPath = safeJoin(path);
      try {
        unlinkSync(fullPath);
      } catch {
        // File may not exist
      }
    },

    async exists(path) {
      const fullPath = safeJoin(path);
      return Bun.file(fullPath).exists();
    },
  };
}
