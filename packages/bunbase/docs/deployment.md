---
title: Deployment
---

Production checklist for deploying a BunBase server.

## Required configuration

These settings are **required** in production (`NODE_ENV=production`):

### CORS origins

```ts
defineConfig({
  cors: {
    origins: ["https://your-app.com"],
  },
});
```

BunBase throws an error at startup if no origins are configured in production.

### OAuth redirect URL

If using OAuth, set the redirect URL:

```ts
defineConfig({
  auth: {
    oauth: {
      redirectUrl: "https://your-app.com",
      google: { clientId: "...", clientSecret: "..." },
    },
  },
});
```

### Magic links, JWTs, and channels

If sending magic-link emails, set `publicUrl` to your public HTTPS origin.
JWT mode also requires a signing secret and explicit `auth.jwt.issuer` and
`auth.jwt.audience` with secure defaults. Broadcast and presence channels require
an explicit `realtime.authorize` callback; authentication alone does not grant
channel access. See [Upgrading to 0.1](/upgrading-01/) for migration guidance.

## Environment variables

```bash
# Required
NODE_ENV=production

# Optional
PORT=3000

# Admin bootstrap (see Admin account below)
BUNBASE_ADMIN_EMAIL=admin@your-app.com
BUNBASE_ADMIN_PASSWORD=change-me

# Service key for server-to-server admin access (auto-generated if omitted)
BUNBASE_SERVICE_KEY=bb_sk_...
```

Bun loads `.env` files automatically. For production, set environment variables through your hosting platform.

## Admin account

In development, BunBase automatically creates an admin account with the credentials `admin@example.com` / `admin` if no admin exists.

In production this does **not** happen. Set `BUNBASE_ADMIN_EMAIL` and `BUNBASE_ADMIN_PASSWORD` environment variables to have BunBase create an admin on first startup:

```bash
BUNBASE_ADMIN_EMAIL=admin@your-app.com
BUNBASE_ADMIN_PASSWORD=a-strong-password
```

If neither variable is set and no admin exists, BunBase logs a warning at startup but continues running. Set the bootstrap variables and restart, or create an admin using database tools. The admin UI requires an existing admin login.

## Example `.env.production`

```bash
NODE_ENV=production
PORT=3000

# Admin bootstrap credentials (used once if no admin exists)
BUNBASE_ADMIN_EMAIL=admin@your-app.com
BUNBASE_ADMIN_PASSWORD=a-strong-password

# Service key (auto-generated if omitted, but set explicitly in production)
BUNBASE_SERVICE_KEY=bb_sk_...

# OAuth (if using)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# S3 storage (if using)
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
```

## File storage

For production, consider using S3 instead of local storage. Local storage works for single-server deployments but doesn't survive container restarts unless the data directory is mounted as a volume.

> **Note:** Files downloaded via `GET /files/:id` are served with `Content-Disposition: attachment`, meaning the browser will download them rather than display them inline. If your app needs to display images or other files directly (e.g. in `<img>` tags), serve them from your S3 bucket URL or a CDN directly rather than proxying through BunBase.

```ts
defineConfig({
  storage: {
    driver: "s3",
    s3: {
      bucket: process.env.S3_BUCKET!,
      region: process.env.S3_REGION!,
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  },
});
```

## Database

BunBase defaults to SQLite at `dbPath` (`./data/db.sqlite`). PostgreSQL and MySQL
are supported through `database.driver` and `database.url`; see
[Configuration](/configuration/). For production:

- Ensure the `data/` directory is on a persistent volume
- Back up the database and uploaded files together; rehearse restoration
- Migrations run automatically on server start

### Deployment topology

The built-in realtime, presence, rate-limit counters, and job scheduler are local
to each application process. A shared PostgreSQL/MySQL database does not share
those services. For 0.1.0, use one BunBase instance when relying on them. Multiple
replicas can duplicate jobs, miss realtime notifications from other replicas,
and each apply their own rate-limit allowance. Direct SQL writes do not emit
realtime events. Distributed coordination is not included in this release.

### Backup and restore

For SQLite with local uploads, the simplest consistent backup is an offline
copy. Substitute your configured paths below. Stop **every** process writing the
database or uploads, disable automatic restart, and wait for shutdown to finish
before copying. BunBase uses SQLite WAL mode: do not copy only the live `.sqlite`
file while writers are running.

```bash
# After the service has stopped; choose a NEW backup directory each time.
backup_dir="/backups/bunbase-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -a ./data "$backup_dir/data"
# Only when using the auto-generated credential file:
cp -p ./.bunbase-service-key "$backup_dir/.bunbase-service-key"
```

Include uploads outside `data/` separately. Store the deployed application,
migrations, Bun/Drizzle versions, and configuration with the backup. Preserve
environment-managed service/JWT/encryption secrets in your secret manager; an
auto-generated service-key file is sensitive and must retain mode `0600`.

Rehearse restoration into a **new directory**, using the same application
version first:

```bash
restore_dir="/srv/bunbase-restore"
mkdir "$restore_dir"
cp -a "$backup_dir/data" "$restore_dir/data"
# Only if present in the backup:
cp -p "$backup_dir/.bunbase-service-key" "$restore_dir/.bunbase-service-key"
chmod 600 "$restore_dir/.bunbase-service-key"
```

Start the same application against the restored database and upload paths with
outbound jobs/email disabled for the rehearsal. Check database integrity, sign
in, read a known record, and download a known file. Retain the original data
until the restore is verified. The production smoke test rehearses offline
copy/restore of a disposable SQLite database and uploads.

For PostgreSQL/MySQL, use database-native backup/restore tooling or managed
snapshots. Pause application writes when coordinating a database backup with
local/S3 file backups; protect and restore object storage separately. Verify a
restore into a disposable database before relying on the backup. The SQLite
copy recipe does not apply to those engines.

## Health check

BunBase exposes a health endpoint at:

```
GET /health
```

Returns `200 OK` with JSON such as `{"status":"ok","version":"0.1.0"}`.
This is a process liveness check: it does not query the database or verify that
startup migrations have completed. Use an application-specific readiness route
that checks required dependencies before routing production traffic.

## Restarts and shutdown

SIGTERM and SIGINT stop accepting new connections and scheduling new jobs, close
WebSockets with code `1001`, and drain requests, running jobs, and pending request
logs before closing the database. The whole shutdown has a ten-second deadline.
If it expires or cleanup fails, remaining connections are terminated and the
process exits with status `1`; a successful shutdown exits `0`.

Allow more than ten seconds in your process manager's termination grace period.
Long-running jobs must tolerate interruption. Programmatic `server.stop()` stops
the listener and scheduling; callers managing the server themselves still own
database cleanup and should await in-flight application work before closing it.

## Running the server

```bash
# Start in production mode
NODE_ENV=production bun src/index.ts

# Or use the package.json script
bun run start
```

## Docker

```dockerfile
FROM oven/bun:1.4.2

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

# Persistent data
VOLUME /app/data

EXPOSE 3000
CMD ["bun", "src/index.ts"]
```

```bash
docker build -t my-app .
docker run -p 3000:3000 -v my-data:/app/data -e NODE_ENV=production my-app
```

## Security checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure `cors.origins` with your frontend domain(s)
- [ ] Set `BUNBASE_ADMIN_EMAIL` and `BUNBASE_ADMIN_PASSWORD` for admin bootstrap
- [ ] Set `auth.oauth.redirectUrl` if using OAuth
- [ ] Configure a mailer or `auth.email.webhook` if using password reset
- [ ] Define access rules for every table (BunBase warns at startup for any unprotected table)
- [ ] Set `trustedProxies` in `defineConfig` if running behind a reverse proxy (nginx, Cloudflare, etc.)
- [ ] Set `cookieDomain` in `defineConfig` if your API and frontend are on different subdomains (e.g. `api.example.com` / `app.example.com`)
- [ ] Set `BUNBASE_SERVICE_KEY` if using server-to-server auth (or retrieve the auto-generated key from `.bunbase-service-key`)
- [ ] Ensure `.bunbase-service-key` is in `.gitignore` if using auto-generated keys
- [ ] Use S3 storage or mount a persistent volume for local storage
- [ ] Rehearse database and file restoration
- [ ] Use one instance for built-in realtime/jobs, or provide external coordination
- [ ] Verify production frontend assets with the deployed `bunfig.toml` plugins and CSP
- [ ] Use HTTPS (via reverse proxy or hosting platform)

## Next steps

- [Configuration](/configuration/) — full config reference
- [Index](/) — back to documentation home
