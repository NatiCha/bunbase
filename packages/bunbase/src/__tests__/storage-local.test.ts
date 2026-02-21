import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLocalStorage } from "../storage/local.ts";

const testDir = join(tmpdir(), `bunbase-storage-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

test("write and read return the same bytes", async () => {
  const storage = createLocalStorage(testDir);
  const data = new TextEncoder().encode("hello world");
  await storage.write("test/hello.txt", data);
  const result = await storage.read("test/hello.txt");
  expect(result).not.toBeNull();
  expect(new TextDecoder().decode(result!)).toBe("hello world");
});

test("read returns null for a non-existent file", async () => {
  const storage = createLocalStorage(testDir);
  const result = await storage.read("does/not/exist.bin");
  expect(result).toBeNull();
});

test("exists returns true after write", async () => {
  const storage = createLocalStorage(testDir);
  await storage.write("existence/file.txt", new Uint8Array([1, 2, 3]));
  expect(await storage.exists("existence/file.txt")).toBe(true);
});

test("exists returns false for missing file", async () => {
  const storage = createLocalStorage(testDir);
  expect(await storage.exists("no-such-file.txt")).toBe(false);
});

test("delete removes the file", async () => {
  const storage = createLocalStorage(testDir);
  await storage.write("to-delete/file.txt", new Uint8Array([9]));
  await storage.delete("to-delete/file.txt");
  expect(await storage.exists("to-delete/file.txt")).toBe(false);
});

test("delete on non-existent file does not throw", async () => {
  const storage = createLocalStorage(testDir);
  await expect(storage.delete("ghost-file.txt")).resolves.toBeUndefined();
});

test("write creates nested directories automatically", async () => {
  const storage = createLocalStorage(testDir);
  const data = new Uint8Array([0xff, 0x00]);
  await storage.write("deep/nested/dir/file.bin", data);
  const result = await storage.read("deep/nested/dir/file.bin");
  expect(result).toEqual(data);
});

test("overwriting a file replaces its contents", async () => {
  const storage = createLocalStorage(testDir);
  await storage.write("overwrite.txt", new TextEncoder().encode("first"));
  await storage.write("overwrite.txt", new TextEncoder().encode("second"));
  const result = await storage.read("overwrite.txt");
  expect(new TextDecoder().decode(result!)).toBe("second");
});
