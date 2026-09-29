---
title: Production operations
---

BunBase 0.2 adds readiness probes, authenticated diagnostics, and a verified offline
backup/restore workflow for SQLite with local uploads.

## Liveness and readiness

`GET /health` is process liveness. `GET /ready` returns `200` with
`{"status":"ready"}` only after startup completes, the database answers `SELECT 1`,
and any application checks pass. Otherwise it returns `503` with
`{"status":"not_ready"}`. `HEAD /ready` returns the same status without a body.
Responses use `Cache-Control: no-store` and never include dependency errors or
configuration. Neither probe writes request-log rows.

```ts
const app = createServer({
  schema,
  rules,
  readiness: {
    timeoutMs: 2000,
    checks: {
      payments: async () => {
        const response = await fetch("https://payments.example.com/health", {
          signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) throw new Error("Payments unavailable");
      },
    },
  },
});
```

Checks resolve to pass or throw to fail. Names must be identifiers up to 64 characters;
`bootstrap`, `database`, `migrations`, `environment`, and `storage` are reserved. Use short, read-only probes and give
network calls their own cancellation signal. Each check has a deadline (default
2 seconds; configurable from 1 to 30,000 ms). A timed-out check is reused until its
underlying work settles, preventing repeated probes from accumulating work. The
HTTP deadline does not cancel arbitrary application code.

`await app.readiness()` provides detailed named results for server-side tooling.
Readiness fails during startup, on startup failure, or after shutdown begins.
It checks connectivity, not every table/query or storage provider. Production
migration failures prevent startup completion. Development mode retains its
existing behavior of warning and continuing when migrations cannot run; use
`doctor` to detect that condition.

`/ready` is reserved; move an existing custom route at that path before upgrading.

## Diagnose a running server

```sh
bunx @naticha/bunbase doctor
bunx @naticha/bunbase doctor --url https://app.example.com --json
```

For a project with BunBase installed, use `bunx bunbase doctor` or the scaffolded
`bun run doctor` script. Diagnostics call `GET /_admin/api/diagnostics` with a service
key. Set `BUNBASE_SERVICE_KEY`, or use `--key-file PATH`. On loopback, the CLI can
read the existing `.bunbase-service-key` file automatically. It never creates a key.
For remote origins, explicitly supply the environment variable or file.

Only a valid service bearer key can read this endpoint; ordinary sessions and API
keys cannot. The endpoint works even when startup failed, and skips database-backed
session lookup and request logging. HTTP is allowed only for loopback origins;
remote origins require HTTPS. Redirects are rejected so keys cannot follow them.

The report checks:

- Startup and database connectivity, plus your readiness checks.
- Development versus production security defaults.
- Local migration SQL against the applied Drizzle journal: pending, changed, and
  missing local migrations. This is migration-history validation, not a full
  comparison of live database structure against the TypeScript schema.
- Read/write access to the configured local upload directory. S3 is reported as
  requiring a separate provider check; diagnostics do not upload a test object.

The report includes a reminder that jobs, realtime, presence, and rate limits are
process-local. It cannot detect your replica count or prove recovery is possible.
No secrets, connection strings, filesystem paths, SQL, or raw dependency exceptions
are included in server reports. `await app.diagnostics()` exposes the same report
inside the application process.

Exit codes: `0` when there are no failing checks; `1` on failure. `--strict` also
exits `1` for warnings. `--json` emits one JSON object for automation. Diagnostics
only inspect; they never apply migrations or change configuration.

## Offline SQLite backup

Stop **every** database and upload writer and disable automatic restarts first.
`--stopped` is an explicit operator assertion; it does not stop or detect processes.
An idle SQLite connection can retain WAL files, which the snapshot includes.

```sh
mkdir -p backups
bunx bunbase backup backups/before-upgrade --stopped
bunx bunbase backup verify backups/before-upgrade
```

Defaults are `--data data`, `--database db.sqlite` (relative to the data directory),
and `--migrations drizzle`. Put **all local uploads** inside the selected data
root. For customized paths:

```sh
bunx bunbase backup /backups/app-2026-09-28 --stopped \
  --data /srv/app/data --database app.sqlite --migrations /srv/app/drizzle
```

The command uses SQLite `VACUUM INTO` to create a standalone snapshot, including
committed WAL contents, then copies local files and migrations. A manifest records
BunBase/Bun versions, creation time, file sizes, and SHA-256 checksums. Integrity and
checksums are verified before success. Backup files are owner-only; symlinks and
special files are rejected. The destination must be new and outside source directories.
Allow free disk space for another copy of the database and all local files.

If using the generated service-key file, explicitly include
`--key-file .bunbase-service-key`; it retains owner-only permissions. Environment
secrets, source code, lockfiles, and application configuration are **not included**.
Retain the matching application version and deployment configuration separately,
and keep environment-managed credentials in your secret manager. Protect and copy
backups off-host. Checksums detect accidental corruption; they do not authenticate
an untrusted backup or encrypt its contents.

This command does not connect to PostgreSQL/MySQL or back up S3. Use database-native
backups and separately coordinated object-storage protection for those deployments.

## Restore into a new directory

```sh
bunx bunbase restore backups/before-upgrade restored
```

The entire bundle is checked before the destination is created. Restore rejects
existing destinations, missing/extra files, duplicate/traversal paths, symlinks,
checksum mismatches, and SQLite integrity failures. It rechecks the copied bytes,
preserves owner-only permissions, and never starts an application or overwrites
live data. Use `--json` with backup, verify, and restore for structured output.

The result contains `data/`, `drizzle/`, and the optional service-key file. Point
an isolated deployment of the **same application version** at those paths and
restore its secrets. For the team-workspace starter, set `BUNBASE_DATA_DIR` and
`BUNBASE_MIGRATIONS_DIR`. When restoring as a different OS user (for example from a
root-run backup container), assign the restored directory to the application's OS
user before starting it.

A complete recovery rehearsal must verify readiness, sign-in, a known record, and
a known file download. Disable outbound jobs/email during rehearsals in applications
that use them. Keep the original data until acceptance is complete. After a
schema-changing upgrade, roll back the application version and its matching backup
together; reverting only application code may not reverse database changes.

See the [team-workspace starter](/team-workspace/) for the included Docker/Caddy
recipe and its volume-based backup commands.
