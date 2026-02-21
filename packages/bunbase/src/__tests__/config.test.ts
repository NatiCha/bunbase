import { test, expect } from "bun:test";
import { defineConfig, resolveConfig } from "../core/config.ts";

// defineConfig

test("defineConfig returns the config unchanged", () => {
  const input = { development: true, dbPath: "./test.sqlite" };
  expect(defineConfig(input)).toBe(input);
});

// resolveConfig — defaults

test("resolveConfig applies default dbPath and migrationsPath", () => {
  const config = resolveConfig({ development: true });
  expect(config.dbPath).toBe("./data/db.sqlite");
  expect(config.migrationsPath).toBe("./drizzle");
});

test("resolveConfig applies default storage driver and maxFileSize", () => {
  const config = resolveConfig({ development: true });
  expect(config.storage.driver).toBe("local");
  expect(config.storage.localPath).toBe("./data/uploads");
  expect(config.storage.maxFileSize).toBe(10 * 1024 * 1024);
});

test("resolveConfig applies default 30-day token expiry", () => {
  const config = resolveConfig({ development: true });
  expect(config.auth.tokenExpiry).toBe(30 * 24 * 60 * 60);
});

test("resolveConfig defaults cors.origins to empty array", () => {
  const config = resolveConfig({ development: true });
  expect(config.cors.origins).toEqual([]);
});

test("resolveConfig with no argument resolves without throwing in dev (NODE_ENV is not production)", () => {
  // The environment in tests is not 'production', so no origins check fires
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const config = resolveConfig();
    expect(config.development).toBe(true);
  } finally {
    process.env.NODE_ENV = original;
  }
});

// resolveConfig — overrides

test("resolveConfig respects custom values", () => {
  const config = resolveConfig({
    development: true,
    dbPath: "./custom.sqlite",
    migrationsPath: "./migrations",
    auth: { tokenExpiry: 3600 },
    storage: { driver: "local", localPath: "./uploads", maxFileSize: 5_000_000 },
    cors: { origins: ["https://app.example.com"] },
  });

  expect(config.dbPath).toBe("./custom.sqlite");
  expect(config.migrationsPath).toBe("./migrations");
  expect(config.auth.tokenExpiry).toBe(3600);
  expect(config.storage.driver).toBe("local");
  expect(config.storage.maxFileSize).toBe(5_000_000);
  expect(config.cors.origins).toEqual(["https://app.example.com"]);
});

// resolveConfig — production validation

test("resolveConfig throws in production when cors.origins is empty", () => {
  expect(() =>
    resolveConfig({ development: false, cors: { origins: [] } }),
  ).toThrow("cors.origins is required in production");
});

test("resolveConfig throws in production when OAuth is configured without redirectUrl", () => {
  expect(() =>
    resolveConfig({
      development: false,
      cors: { origins: ["https://app.example.com"] },
      auth: {
        oauth: {
          github: { clientId: "id", clientSecret: "secret" },
        },
      },
    }),
  ).toThrow("auth.oauth.redirectUrl is required in production");
});

test("resolveConfig does not throw in production when redirectUrl is provided", () => {
  expect(() =>
    resolveConfig({
      development: false,
      cors: { origins: ["https://app.example.com"] },
      auth: {
        oauth: {
          redirectUrl: "https://app.example.com/auth/callback",
          github: { clientId: "id", clientSecret: "secret" },
        },
      },
    }),
  ).not.toThrow();
});

test("resolveConfig does not throw in production when no OAuth is configured", () => {
  expect(() =>
    resolveConfig({
      development: false,
      cors: { origins: ["https://app.example.com"] },
    }),
  ).not.toThrow();
});
