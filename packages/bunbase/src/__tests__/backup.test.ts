import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, restore, verifyBackup } from "../cli/backup.ts";

const root = mkdtempSync(join(tmpdir(), "bunbase-backup-"));
const data = join(root, "data");
const migrations = join(root, "drizzle");
mkdirSync(join(data, "uploads"), { recursive: true });
mkdirSync(migrations);
writeFileSync(join(data, "uploads", "proposal.txt"), "private attachment");
const keyFile = join(root, "key");
writeFileSync(keyFile, `bb_sk_${"a".repeat(32)}`);
const db = new Database(join(data, "db.sqlite"));
db.run("PRAGMA journal_mode=WAL");
db.run("CREATE TABLE records (value TEXT)");
db.query("INSERT INTO records VALUES (?)").run("kept from WAL");
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const bundle = join(root, "bundle");

test("backup captures WAL, uploads and optional key; restore verifies into a new directory", async () => {
  // An idle SQLite connection deliberately retains a WAL file. Application writers are stopped.
  const manifest = await backup({ destination: bundle, data, migrations, keyFile, stopped: true });
  expect(manifest.files.some((file) => file.path === "data/uploads/proposal.txt")).toBe(true);
  expect(manifest.files.some((file) => file.path.endsWith("-wal"))).toBe(false);
  expect((await verifyBackup(bundle)).format).toBe(1);
  const restored = join(root, "restored");
  await restore(bundle, restored);
  using copy = new Database(join(restored, "data", "db.sqlite"), { readonly: true });
  expect(copy.query("SELECT value FROM records").get()).toEqual({ value: "kept from WAL" });
  expect(readFileSync(join(restored, "data", "uploads", "proposal.txt"), "utf8")).toBe(
    "private attachment",
  );
  expect(statSync(join(restored, ".bunbase-service-key")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(restored, "drizzle"))).toBe(true);
});

test("backup requires offline acknowledgement and refuses nested or existing destinations", async () => {
  await expect(
    backup({ destination: join(root, "not-created"), data, migrations, stopped: false }),
  ).rejects.toThrow("Stop every");
  expect(existsSync(join(root, "not-created"))).toBe(false);
  await expect(
    backup({ destination: join(data, "nested"), data, migrations, stopped: true }),
  ).rejects.toThrow("outside");
  await expect(backup({ destination: bundle, data, migrations, stopped: true })).rejects.toThrow();
  await expect(restore(bundle, data)).rejects.toThrow();
  expect(readFileSync(join(data, "uploads", "proposal.txt"), "utf8")).toBe("private attachment");
});

test("backup rejects symlinks without following them", async () => {
  symlinkSync(keyFile, join(data, "linked-key"));
  try {
    await expect(
      backup({ destination: join(root, "linked"), data, migrations, stopped: true }),
    ).rejects.toThrow("Symlinks");
  } finally {
    rmSync(join(data, "linked-key"));
  }
  expect(existsSync(join(root, "linked"))).toBe(false);
});

test("restore rejects corrupt, unlisted, duplicate, and traversal entries before creating a destination", async () => {
  const original = readFileSync(join(bundle, "manifest.json"), "utf8");
  const manifest = JSON.parse(original);
  const target = join(root, "never-created");
  writeFileSync(join(bundle, "data", "uploads", "proposal.txt"), "tampered");
  await expect(restore(bundle, target)).rejects.toThrow("checksum");
  writeFileSync(join(bundle, "data", "uploads", "proposal.txt"), "private attachment");
  writeFileSync(join(bundle, "unlisted"), "extra");
  await expect(restore(bundle, target)).rejects.toThrow("unlisted");
  rmSync(join(bundle, "unlisted"));
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({ ...manifest, files: [...manifest.files, manifest.files[0]] }),
  );
  await expect(restore(bundle, target)).rejects.toThrow("manifest");
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({ ...manifest, database: "../outside.sqlite" }),
  );
  await expect(restore(bundle, target)).rejects.toThrow();
  writeFileSync(join(bundle, "manifest.json"), original);
  expect(existsSync(target)).toBe(false);
});
