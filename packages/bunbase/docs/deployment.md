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

## Environment variables

```bash
# Required
NODE_ENV=production

# Optional
PORT=3000

# Admin bootstrap (see Admin account below)
BUNBASE_ADMIN_EMAIL=admin@your-app.com
BUNBASE_ADMIN_PASSWORD=change-me
```

Bun loads `.env` files automatically. For production, set environment variables through your hosting platform.

## Admin account

In development, BunBase automatically creates an admin account with the credentials `admin@example.com` / `admin` if no admin exists.

In production this does **not** happen. Set `BUNBASE_ADMIN_EMAIL` and `BUNBASE_ADMIN_PASSWORD` environment variables to have BunBase create an admin on first startup:

```bash
BUNBASE_ADMIN_EMAIL=admin@your-app.com
BUNBASE_ADMIN_PASSWORD=a-strong-password
```

If neither variable is set and no admin exists, BunBase logs a warning at startup but continues running. You can create an admin manually through the admin UI or database tools at any time.

## Example `.env.production`

```bash
NODE_ENV=production
PORT=3000

# Admin bootstrap credentials (used once if no admin exists)
BUNBASE_ADMIN_EMAIL=admin@your-app.com
BUNBASE_ADMIN_PASSWORD=a-strong-password

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

BunBase uses SQLite stored at `dbPath` (default `./data/db.sqlite`). For production:

- Ensure the `data/` directory is on a persistent volume
- Back up the SQLite file regularly
- Migrations run automatically on server start

## Health check

BunBase exposes a health endpoint at:

```
GET /health
```

Returns `200 OK` with body `"OK"`. Use this for load balancer health checks, container orchestration, and uptime monitoring.

## Running the server

```bash
# Start in production mode
NODE_ENV=production bun src/index.ts

# Or use the package.json script
bun run start
```

## Docker

```dockerfile
FROM oven/bun:latest

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
- [ ] Configure `auth.email.webhook` if using password reset
- [ ] Define access rules for every table (BunBase warns at startup for any unprotected table)
- [ ] Set `trustedProxies` in `defineConfig` if running behind a reverse proxy (nginx, Cloudflare, etc.)
- [ ] Set `cookieDomain` in `defineConfig` if your API and frontend are on different subdomains (e.g. `api.example.com` / `app.example.com`)
- [ ] Use S3 storage or mount a persistent volume for local storage
- [ ] Back up the SQLite database
- [ ] Use HTTPS (via reverse proxy or hosting platform)

## Next steps

- [Configuration](/configuration/) — full config reference
- [Index](/) — back to documentation home
