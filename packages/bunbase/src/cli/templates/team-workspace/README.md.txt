# Team workspace

A BunBase application for team requests and approvals. Includes a responsive UI,
email/password login, workspaces, invitations, private attachments, and an atomic
approval action. Workspace owners/admins approve; members create and read requests.
Each workspace is isolated by persisted membership, including file operations.

## Run locally

```sh
bun install
bun run db:generate
bun dev
```

Open http://localhost:3000, create your own account, and create a workspace.
Invite a second account, copy the invitation token, and accept it while signed in
with the invited email. Tokens are shared manually; this starter does not send
invitation email. Use **Refresh** to reload changes from other team members.

```sh
bun run type
bun test
bun run doctor
```

The tests cover organization boundaries, revoked members, private attachments,
protected fields, and competing approvals. The starter fixes the database to
SQLite; PostgreSQL/MySQL remain supported by the library and other templates.

## Files to make your own

- `src/schema.ts`: users and requests; built-in organizations own membership.
- `src/rules.ts`: SQL filters, organization checks, server-assigned fields.
- `src/routes.ts`: approval and authorized attachment listing.
- `src/portal/`: UI and typed SDK usage.
- `src/index.ts`: environment, local storage, frontend, and server composition.

The global BunBase admin panel is for trusted operators. It is a separate
privileged administration surface; customer users should use this application.

## Deploy with Docker and HTTPS

1. Install Docker with Compose on a server and point a domain at that server.
   Allow inbound ports 80 and 443. Keep one app instance for this deployment.
2. Run `bun install` and `bun run db:generate`; commit the application, `bun.lock`,
   and the generated `drizzle/` migrations. Review migration SQL before deploying.
3. Set these values in the server's `.env` (never commit that file):

```dotenv
APP_DOMAIN=workspace.example.com
PUBLIC_URL=https://workspace.example.com
BUNBASE_ADMIN_EMAIL=operator@example.com
BUNBASE_ADMIN_PASSWORD=replace-with-a-long-unique-password
BUNBASE_SERVICE_KEY=replace-with-the-generated-key
```

Generate a service key with `bun -e 'console.log("bb_sk_" + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"))'`.
Preserve that value in a secret manager. Bootstrap credentials create the first
operator account; change its password in the admin panel as appropriate.

```sh
docker compose up -d --build
docker compose ps
docker compose exec app bun run doctor
```

Caddy obtains TLS certificates for your domain. The app port is private to the
Compose network; `/ready` gates container health. Use the public HTTPS origin for
browser acceptance. The application remains at the same URL through upgrades.

A native Bun deployment can run the same `bun start` command behind an HTTPS
reverse proxy with a persistent `data/` directory. Set the same environment values.
`BUNBASE_DATA_DIR` and `BUNBASE_MIGRATIONS_DIR` override those directories.

## Back up, upgrade, and rehearse restoration

The backup CLI is for **offline SQLite plus local files**. Stop every writer and
disable automatic restarts before passing `--stopped`; the flag is your assertion,
not a process detector. All uploads must live inside the supplied data directory.
PostgreSQL, MySQL, and S3 need their own backup tools.

For a native deployment, stop the service, then run from the app directory:

```sh
mkdir -p backups
bun run backup backups/before-upgrade --stopped
bunx bunbase backup verify backups/before-upgrade
bun run restore backups/before-upgrade restored
```

The destination must not already exist. Backups contain a standalone SQLite
snapshot (including WAL contents), local files, migrations, and checksums.
Include `--key-file .bunbase-service-key` only if using an auto-generated key.
Application source, environment secrets, and external services are not included.

For Compose, stop the app and use its existing data volume:

```sh
mkdir -p backups
chmod 700 backups
docker compose stop app
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backups" app bun run backup /backups/before-upgrade --stopped
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backups" app bun node_modules/@naticha/bunbase/src/cli/index.ts backup verify /backups/before-upgrade
```

Backup files are owner-only. The one-off container uses root so it can write the
host-mounted backup directory; keep those files protected and copy them off-host.
To resume after a successful backup, run `docker compose up -d app`.
Do not run `docker compose down -v`: that removes your application data volume.

Rehearse using the **same application version** in a separate directory/container.
Restore into a new directory, use its `data` and `drizzle` paths, and restore secrets
from your secret manager. Disable outbound side effects in any application changes
you add. Verify `/ready`, sign in, read a known request, and download its attachment.
Only then rely on the backup. A checksum check alone is not a recovery rehearsal.

For an upgrade, keep the old application version and a verified backup, stop the
app, deploy reviewed code/migrations, and start it. Check readiness, diagnostics,
login, records, and files. If a migration changed the data, reverting code alone
is not a rollback: restore the matching backup and application version together.
