import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pkg from "../../package.json";
import type { DatabaseAdapter } from "./adapter.ts";
import type { ResolvedConfig } from "./config.ts";

export interface ReadinessOptions {
  /** Additional dependencies. Resolve to pass; throw to fail. Errors are never returned to clients. */
  checks?: Record<string, () => void | Promise<void>>;
  /** Deadline per check, in milliseconds. Default: 2000. */
  timeoutMs?: number;
}

export interface DiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: DiagnosticCheck[];
}

export interface DiagnosticsReport {
  notes: string[];
  version: string;
  status: "pass" | "warn" | "fail";
  checks: DiagnosticCheck[];
}

/** Bound response time without exposing dependency errors or issuing overlapping probes. */
export function dependencyCheck(name: string, run: () => void | Promise<void>, timeoutMs: number) {
  let pending: Promise<DiagnosticCheck> | undefined;
  return async (): Promise<DiagnosticCheck> => {
    if (!pending) {
      pending = Promise.resolve()
        .then(run)
        .then(
          () => ({ name, status: "pass", message: "Available." }) as const,
          () =>
            ({
              name,
              status: "fail",
              message: "Unavailable; inspect server logs or configuration.",
            }) as const,
        );
      void pending.then(() => {
        pending = undefined;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<DiagnosticCheck>((resolve) => {
          timer = setTimeout(
            () => resolve({ name, status: "fail", message: "Check timed out." }),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function migrationCheck(
  adapter: DatabaseAdapter,
  path: string,
): Promise<DiagnosticCheck> {
  const local = readMigrationFiles({ migrationsFolder: path });
  const table =
    adapter.dialect === "postgres" ? '"drizzle"."__drizzle_migrations"' : "__drizzle_migrations";
  const applied = await adapter.rawQuery<{ name: string | null; hash: string }>(
    `SELECT name, hash FROM ${table}`,
  );
  const byName = new Map(applied.map((entry) => [entry.name, entry.hash]));
  const localNames = new Set(local.map((entry) => entry.name));
  const pending = local.filter((entry) => !byName.has(entry.name)).length;
  const changed = local.filter(
    (entry) => byName.has(entry.name) && byName.get(entry.name) !== entry.hash,
  ).length;
  const missing = applied.filter((entry) => !entry.name || !localNames.has(entry.name)).length;
  return {
    name: "migrations",
    status: pending || changed || missing ? "fail" : "pass",
    message: `${local.length} local, ${applied.length} applied; ${pending} pending, ${changed} changed, ${missing} missing locally.`,
  };
}

export function validateReadinessOptions(options: ReadinessOptions = {}): number {
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("BunBase: readiness.timeoutMs must be an integer from 1 to 30000.");
  }
  for (const [name, check] of Object.entries(options.checks ?? {})) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
      ["bootstrap", "database", "migrations", "environment", "storage"].includes(name) ||
      typeof check !== "function"
    ) {
      throw new Error(
        "BunBase: readiness checks require functions named with non-reserved identifiers.",
      );
    }
  }
  return timeoutMs;
}

export function createDiagnostics(
  adapter: DatabaseAdapter,
  config: ResolvedConfig,
  bootstrap: () => "starting" | "ready" | "failed",
  options: ReadinessOptions = {},
) {
  const timeoutMs = validateReadinessOptions(options);
  const checks = [
    dependencyCheck(
      "database",
      async () => {
        await adapter.rawQuery("SELECT 1");
      },
      timeoutMs,
    ),
  ];
  for (const [name, check] of Object.entries(options.checks ?? {})) {
    checks.push(dependencyCheck(name, check, timeoutMs));
  }
  const migrations = dependencyCheck(
    "migration-check",
    async () => {
      migrationResult = await migrationCheck(adapter, config.migrationsPath);
    },
    timeoutMs,
  );
  let migrationResult: DiagnosticCheck | undefined;
  const storage = dependencyCheck(
    "storage",
    async () => {
      if (!(await stat(config.storage.localPath)).isDirectory())
        throw new Error("Upload path must be a directory.");
      await access(config.storage.localPath, constants.R_OK | constants.W_OK | constants.X_OK);
    },
    timeoutMs,
  );
  async function readiness(stopping = false): Promise<ReadinessReport> {
    const state = bootstrap();
    if (stopping || state !== "ready") {
      return {
        status: "not_ready",
        checks: [
          {
            name: "bootstrap",
            status: "fail",
            message: stopping
              ? "Shutting down."
              : state === "failed"
                ? "Startup failed; inspect server logs."
                : "Startup is in progress.",
          },
        ],
      };
    }
    const results: DiagnosticCheck[] = [
      { name: "bootstrap", status: "pass", message: "Startup completed." },
      ...(await Promise.all(checks.map((check) => check()))),
    ];
    return {
      status: results.some((check) => check.status === "fail") ? "not_ready" : "ready",
      checks: results,
    };
  }
  async function diagnostics(stopping = false): Promise<DiagnosticsReport> {
    const ready = await readiness(stopping);
    const results = [...ready.checks];
    results.push({
      name: "environment",
      status: config.secureDefaults ? "pass" : "warn",
      message: config.secureDefaults
        ? "Production security defaults enabled."
        : "Development mode is enabled; do not expose this server publicly.",
    });
    if (ready.status === "ready") {
      const result = await migrations();
      results.push(
        result.status === "pass" && migrationResult
          ? migrationResult
          : { ...result, name: "migrations" },
      );
    }
    if (config.storage.driver === "local") {
      results.push(await storage());
    } else {
      results.push({
        name: "storage",
        status: "warn",
        message: "S3 is configured; connectivity and object recovery require a separate check.",
      });
    }
    return {
      notes: [
        "Built-in jobs, realtime, presence, and rate limits are per process. Use one application instance; replica count is not detected.",
      ],
      version: pkg.version,
      status: results.some((check) => check.status === "fail")
        ? "fail"
        : results.some((check) => check.status === "warn")
          ? "warn"
          : "pass",
      checks: results,
    };
  }
  return { readiness, diagnostics };
}
