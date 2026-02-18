import { test, expect, afterEach, spyOn } from "bun:test";
import { createS3Storage } from "../storage/s3.ts";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    ...overrides,
  };
}

// ─── write ───────────────────────────────────────────────────────────────────

test("write sends a PUT request and resolves when response is ok", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 200 }) as any,
  );

  const storage = createS3Storage(makeConfig());
  await expect(
    storage.write("data/file.txt", new Uint8Array([1, 2, 3])),
  ).resolves.toBeUndefined();

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("data/file.txt");
  expect(init.method).toBe("PUT");
  expect(init.headers).toBeDefined();
});

test("write throws when S3 returns a non-ok status", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("Forbidden", { status: 403, statusText: "Forbidden" }) as any,
  );

  const storage = createS3Storage(makeConfig());
  await expect(
    storage.write("bad/file.txt", new Uint8Array()),
  ).rejects.toThrow("S3 write failed");
});

// ─── read ────────────────────────────────────────────────────────────────────

test("read sends a GET request and returns Uint8Array when ok", async () => {
  const content = new Uint8Array([10, 20, 30]);
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(content) as any,
  );

  const storage = createS3Storage(makeConfig());
  const result = await storage.read("data/file.txt");
  expect(result).not.toBeNull();
  expect(result![0]).toBe(10);
  expect(result![1]).toBe(20);

  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(init.method).toBe("GET");
});

test("read returns null when S3 response is not ok", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }) as any,
  );

  const storage = createS3Storage(makeConfig());
  const result = await storage.read("missing/file.txt");
  expect(result).toBeNull();
});

// ─── delete ──────────────────────────────────────────────────────────────────

test("delete sends a DELETE request", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 204 }) as any,
  );

  const storage = createS3Storage(makeConfig());
  await storage.delete("data/file.txt");

  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(init.method).toBe("DELETE");
});

// ─── exists ──────────────────────────────────────────────────────────────────

test("exists returns true when HEAD request succeeds", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 200 }) as any,
  );

  const storage = createS3Storage(makeConfig());
  expect(await storage.exists("data/file.txt")).toBe(true);
});

test("exists returns false when HEAD request returns non-ok status", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 404 }) as any,
  );

  const storage = createS3Storage(makeConfig());
  expect(await storage.exists("missing/file.txt")).toBe(false);
});

// ─── endpoint ────────────────────────────────────────────────────────────────

test("uses default endpoint derived from bucket and region", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 200 }) as any,
  );

  const storage = createS3Storage(
    makeConfig({ bucket: "mybucket", region: "eu-west-1" }),
  );
  await storage.delete("some/path.txt");

  const [url] = fetchSpy.mock.calls[0] as [string];
  expect(url).toContain("mybucket.s3.eu-west-1.amazonaws.com");
});

test("uses custom endpoint when provided", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("", { status: 200 }) as any,
  );

  const storage = createS3Storage(
    makeConfig({ endpoint: "https://s3.custom.example.com" }),
  );
  await storage.delete("some/path.txt");

  const [url] = fetchSpy.mock.calls[0] as [string];
  expect(url).toContain("s3.custom.example.com");
  expect(url).not.toContain("amazonaws.com");
});
