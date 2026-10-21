#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { INIT_HELP, parseInitArgs } from "./args.ts";
import { backup, restore, verifyBackup } from "./backup.ts";
import { doctor } from "./doctor.ts";
import { init } from "./init.ts";

const HELP = `BunBase CLI

${INIT_HELP}

Production operations:
  doctor [--url https://app.example.com] [--key-file PATH] [--json] [--strict]
    Read authenticated diagnostics. Uses BUNBASE_SERVICE_KEY; on loopback falls
    back to .bunbase-service-key. Exit 1 on failures (also warnings with --strict).
  backup DESTINATION --stopped [--data data] [--database db.sqlite]
    [--migrations drizzle] [--key-file .bunbase-service-key] [--json]
    Offline SQLite/local-file backup. Stop ALL writers and automatic restarts.
    Database and ALL uploads must be inside --data. Destination must not exist.
  backup verify DIRECTORY [--json]
    Verify the manifest, all checksums, and SQLite integrity without restoring.
  restore BACKUP DESTINATION [--json]
    Verify and restore data/migrations into a NEW directory. Never starts a server.
    Deploy the same application version and restore environment secrets separately.

PostgreSQL, MySQL, and S3 require their native backup tools; this backup command
 does not connect to them or include application source/environment files.`;

const args = process.argv.slice(2);
try {
  const command = args.shift();
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    console.log(HELP);
  } else if (command === "init") {
    await init(parseInitArgs(args));
  } else if (command === "doctor") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        url: { type: "string" },
        "key-file": { type: "string" },
        json: { type: "boolean" },
        strict: { type: "boolean" },
      },
    });
    if (positionals.length) throw new Error("doctor does not accept positional arguments.");
    const report = await doctor({ url: values.url, keyFile: values["key-file"] });
    console.log(
      values.json
        ? JSON.stringify(report)
        : [
            `BunBase ${report.version}: ${report.status}`,
            ...report.checks.map(
              (check) => `  ${check.status.toUpperCase()} ${check.name}: ${check.message}`,
            ),
            ...report.notes.map((note) => `  NOTE ${note}`),
          ].join("\n"),
    );
    process.exitCode =
      report.status === "fail" || (values.strict && report.status === "warn") ? 1 : 0;
  } else if (command === "backup" && args[0] !== "verify") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        stopped: { type: "boolean" },
        data: { type: "string" },
        database: { type: "string" },
        migrations: { type: "string" },
        "key-file": { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (positionals.length !== 1) throw new Error("Usage: bunbase backup DESTINATION --stopped");
    const manifest = await backup({
      destination: positionals[0]!,
      stopped: values.stopped ?? false,
      data: values.data,
      database: values.database,
      migrations: values.migrations,
      keyFile: values["key-file"],
    });
    console.log(
      values.json
        ? JSON.stringify({ status: "ok", ...manifest })
        : `Backup verified: ${manifest.files.length} files. Keep the application version and environment secrets separately.`,
    );
  } else if (command === "restore" || (command === "backup" && args[0] === "verify")) {
    if (command === "backup") args.shift();
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
    if (positionals.length !== (command === "restore" ? 2 : 1))
      throw new Error("Usage: bunbase restore BACKUP DESTINATION, or bunbase backup verify BACKUP");
    const manifest =
      command === "restore"
        ? await restore(positionals[0]!, positionals[1]!)
        : await verifyBackup(positionals[0]!);
    console.log(
      values.json
        ? JSON.stringify({ status: "ok", ...manifest })
        : command === "restore"
          ? "Restore verified. Deploy the same application version and restore secrets; no server was started."
          : "Backup checksums and SQLite integrity verified.",
    );
  } else {
    throw new Error("Unknown command. Run bunbase --help.");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Operation failed.";
  if (args.includes("--json")) console.log(JSON.stringify({ status: "fail", message }));
  else console.error(message);
  process.exitCode = 1;
}
