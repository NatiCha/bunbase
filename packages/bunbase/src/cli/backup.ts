import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import pkg from "../../package.json";

const safePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !path.includes("\0") &&
      !path.includes(":") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a relative path without traversal.",
  );
const manifestSchema = z.object({
  format: z.literal(1),
  bunbaseVersion: z.string(),
  bunVersion: z.string(),
  createdAt: z.string(),
  database: safePath,
  files: z.array(
    z.object({
      path: safePath,
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
type Manifest = z.infer<typeof manifestSchema>;

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Refuse symlinks and special files; never traverse them during backup or restoration. */
async function filesIn(root: string, path = ""): Promise<string[]> {
  const stat = await lstat(join(root, path));
  if (stat.isSymbolicLink()) throw new Error("Symlinks are not supported in backup inputs.");
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error("Backup inputs must be regular files or directories.");
  const results: string[] = [];
  for (const name of (await readdir(join(root, path))).sort()) {
    const child = path ? `${path}/${name}` : name;
    safePath.parse(child);
    results.push(...(await filesIn(root, child)));
  }
  return results;
}

async function copyTree(source: string, target: string, skip: Set<string> = new Set()) {
  for (const path of await filesIn(source)) {
    if (skip.has(path)) continue;
    const dest = join(target, path);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(join(source, path), dest);
    await chmod(dest, 0o600);
  }
}

async function newDirectory(path: string, sources: string[]): Promise<string> {
  const parent = await realpath(dirname(resolve(path)));
  const target = join(parent, resolve(path).split(sep).at(-1)!);
  for (const source of sources) {
    const canonical = await realpath(source);
    if (target === canonical || target.startsWith(`${canonical}${sep}`)) {
      throw new Error("Destination must be outside the source directories.");
    }
  }
  // Exclusive creation; existing directories are never overwritten, even when empty.
  await mkdir(target, { mode: 0o700 });
  return target;
}

function checkDatabase(path: string) {
  using db = new Database(path, { readonly: true, strict: true });
  const rows = db.query("PRAGMA integrity_check").values();
  if (rows.length !== 1 || rows[0]?.[0] !== "ok") throw new Error("SQLite integrity check failed.");
}

export async function backup(options: {
  destination: string;
  stopped: boolean;
  data?: string;
  database?: string;
  migrations?: string;
  keyFile?: string;
}): Promise<Manifest> {
  if (!options.stopped)
    throw new Error(
      "Stop every database/upload writer and disable automatic restarts, then pass --stopped. This is an offline backup.",
    );
  const data = resolve(options.data ?? "data");
  const migrations = resolve(options.migrations ?? "drizzle");
  const database = safePath.parse(options.database ?? "db.sqlite");
  const inventory = await filesIn(data);
  if (!inventory.includes(database))
    throw new Error("Database must be a regular SQLite file inside --data.");
  await filesIn(migrations);
  if (options.keyFile && !(await lstat(options.keyFile)).isFile())
    throw new Error("Service key must be a regular file.");
  const target = await newDirectory(options.destination, [data, migrations]);
  try {
    await mkdir(join(target, "data"), { mode: 0o700 });
    // SQLite's VACUUM INTO writes a consistent, standalone snapshot, including WAL contents.
    // The operator must still stop ALL writers so uploaded files match that snapshot.
    using db = new Database(join(data, database), { readonly: true, strict: true });
    const snapshot = join(target, "data", database);
    await mkdir(dirname(snapshot), { recursive: true, mode: 0o700 });
    db.query("VACUUM INTO ?").run(snapshot);
    await chmod(snapshot, 0o600);
    await copyTree(
      data,
      join(target, "data"),
      new Set([database, `${database}-wal`, `${database}-shm`, `${database}-journal`]),
    );
    await mkdir(join(target, "drizzle"), { mode: 0o700 });
    await copyTree(migrations, join(target, "drizzle"));
    if (options.keyFile) {
      await copyFile(options.keyFile, join(target, ".bunbase-service-key"));
      await chmod(join(target, ".bunbase-service-key"), 0o600);
    }
    checkDatabase(snapshot);
    const files: Manifest["files"] = [];
    for (const path of await filesIn(target)) {
      files.push({
        path,
        size: (await lstat(join(target, path))).size,
        sha256: await digest(join(target, path)),
      });
    }
    const manifest: Manifest = {
      format: 1,
      bunbaseVersion: pkg.version,
      bunVersion: Bun.version,
      createdAt: new Date().toISOString(),
      database: `data/${database}`,
      files,
    };
    await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await verifyBackup(target);
    return manifest;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(path: string): Promise<Manifest> {
  const root = resolve(path);
  const inventory = await filesIn(root);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(root, "manifest.json"), "utf8")),
  );
  const listed = new Set(manifest.files.map((file) => file.path));
  if (
    listed.size !== manifest.files.length ||
    !listed.has(manifest.database) ||
    !manifest.database.startsWith("data/") ||
    listed.has("manifest.json")
  )
    throw new Error("Invalid backup file manifest.");
  for (const path of listed) {
    if (
      !path.startsWith("data/") &&
      !path.startsWith("drizzle/") &&
      path !== ".bunbase-service-key"
    )
      throw new Error("Unexpected backup path.");
  }
  if (
    inventory.length !== listed.size + 1 ||
    inventory.some((file) => file !== "manifest.json" && !listed.has(file))
  )
    throw new Error("Backup contains missing or unlisted files.");
  for (const file of manifest.files) {
    const full = join(root, file.path);
    if ((await lstat(full)).size !== file.size || (await digest(full)) !== file.sha256)
      throw new Error("Backup checksum mismatch; restore was not started.");
  }
  checkDatabase(join(root, manifest.database));
  return manifest;
}

export async function restore(source: string, destination: string): Promise<Manifest> {
  const manifest = await verifyBackup(source);
  const target = await newDirectory(destination, [source]);
  try {
    await copyTree(resolve(source), target, new Set(["manifest.json"]));
    await mkdir(join(target, "drizzle"), { recursive: true, mode: 0o700 });
    await mkdir(join(target, "data", "uploads"), { recursive: true, mode: 0o700 });
    // Recheck destination bytes as well, including source changes during the copy.
    for (const file of manifest.files) {
      if ((await digest(join(target, file.path))) !== file.sha256)
        throw new Error("Restored checksum mismatch.");
    }
    checkDatabase(join(target, manifest.database));
    return manifest;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
