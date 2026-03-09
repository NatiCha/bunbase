---
title: Configuration
---

Use `defineConfig` to customize BunBase behavior. All options are optional — sensible defaults are provided.

## Full interface

```ts
import { defineConfig } from "bunbase";

const config = defineConfig({
  // Development mode (default: NODE_ENV !== "production")
  development: true,

  // Database — SQLite by default, Postgres and MySQL also supported
  database: {
    driver: "sqlite",          // "sqlite" | "postgres" | "mysql"
    path: "./data/db.sqlite",  // SQLite only
    // url: "postgres://...",  // connection string (alternative to path/host/…)
  },

  // Drizzle migrations directory (default: "./drizzle")
  migrationsPath: "./drizzle",

  auth: {
    // Session TTL in seconds (default: 30 days)
    tokenExpiry: 30 * 24 * 60 * 60,

    email: {
      // Webhook URL called for password reset emails
      webhook: "https://your-app.com/api/send-email",
    },

    oauth: {
      // Required in production when using OAuth
      redirectUrl: "https://your-app.com",

      google: {
        clientId: "...",
        clientSecret: "...",
        scopes: ["openid", "email", "profile"], // optional
      },
      github: {
        clientId: "...",
        clientSecret: "...",
      },
      discord: {
        clientId: "...",
        clientSecret: "...",
      },
    },

    apiKeys: {
      // Default TTL for new keys in days. 0 = no expiration by default. (default: 365)
      defaultExpirationDays: 90,
      // Hard cap on TTL. null = no cap. (default: null)
      maxExpirationDays: 365,
    },

    emailVerification: {
      // Auto-send a verification email on registration when a mailer is configured
      // and the users table has an emailVerified column. (default: true)
      autoSend: true,
    },
  },

  storage: {
    // "local" or "s3" (default: "local")
    driver: "local",

    // Local storage path (default: "./data/uploads")
    localPath: "./data/uploads",

    // S3 configuration (required when driver is "s3")
    s3: {
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: "...",
      secretAccessKey: "...",
      endpoint: "https://...", // optional, for S3-compatible services
    },

    // Max upload size in bytes (default: 10MB)
    maxFileSize: 10 * 1024 * 1024,

    // Restrict allowed MIME types (default: all types allowed)
    allowedMimeTypes: ["image/png", "image/jpeg", "application/pdf"],
  },

  cors: {
    // Allowed origins (required in production)
    origins: ["https://your-app.com"],
  },

  realtime: {
    // Enable WebSocket endpoint at /realtime (default: false)
    enabled: true,
  },

  // IPs of trusted reverse proxies (exact match, no CIDR). When a request
  // arrives from one of these IPs, BunBase trusts X-Forwarded-For / X-Real-IP
  // for rate limiting. When unset, the socket IP is used directly.
  trustedProxies: ["127.0.0.1"],

  // Cookie domain — share session cookies across subdomains (default: unset)
  cookieDomain: ".example.com",
});
```

## Section reference

### `development`

When `true`, BunBase runs in development mode:
- CORS allows all origins
- OAuth uses `http://localhost:3000` as callback base URL
- Cookies are set without the `Secure` flag
- Password reset tokens are logged to the console

Default: `process.env.NODE_ENV !== "production"`

### `database`

Selects the database driver and connection. Three drivers are supported: `"sqlite"` (default), `"postgres"`, and `"mysql"`.

#### SQLite (default)

```ts
database: {
  driver: "sqlite",
  path: "./data/db.sqlite", // default
}
```

The directory is created automatically if it doesn't exist.

#### PostgreSQL

```ts
database: {
  driver: "postgres",
  url: "postgres://user:pass@localhost:5432/mydb",
}
```

Or use individual fields instead of a connection string:

```ts
database: {
  driver: "postgres",
  host: "localhost",
  port: 5432,       // default
  user: "myuser",
  password: "secret",
  dbName: "mydb",
}
```

BunBase automatically creates the database if it doesn't exist (connects to the `postgres` maintenance database to run `CREATE DATABASE`).

Your schema must use `pgTable` from `drizzle-orm/pg-core`:

```ts
import { pgTable, text } from "drizzle-orm/pg-core";

export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
```

Update `drizzle.config.ts` to use the `postgresql` dialect:

```ts
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

#### MySQL

```ts
database: {
  driver: "mysql",
  url: "mysql://user:pass@localhost:3306/mydb",
}
```

Or use individual fields:

```ts
database: {
  driver: "mysql",
  host: "localhost",
  port: 3306,       // default
  user: "root",
  password: "secret",
  dbName: "mydb",
}
```

BunBase automatically creates the database if it doesn't exist (connects to the `mysql` system database to run `CREATE DATABASE IF NOT EXISTS`).

Your schema must use `mysqlTable` from `drizzle-orm/mysql-core`:

```ts
import { mysqlTable, varchar } from "drizzle-orm/mysql-core";

export const posts = mysqlTable("posts", {
  id: varchar("id", { length: 36 }).primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
});
```

Update `drizzle.config.ts` to use the `mysql` dialect:

```ts
export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

### `migrationsPath`

Directory where Drizzle Kit stores generated migration files. BunBase runs all pending migrations on startup.

Default: `"./drizzle"`

### `auth.tokenExpiry`

Session duration in seconds. After this period, users must log in again.

Default: `2592000` (30 days)

### `auth.email.webhook`

A URL that BunBase will POST to when a password reset is requested. The webhook receives:

```json
{
  "type": "password_reset",
  "email": "user@example.com",
  "token": "reset-token-uuid",
  "userId": "user-id"
}
```

Your webhook should send the actual email with a reset link containing the token. Required in production for password resets to work.

### `auth.oauth`

Configure OAuth providers. Each provider needs a `clientId` and `clientSecret` from the provider's developer console.

`redirectUrl` is the base URL for OAuth callbacks. In development, this defaults to `http://localhost:3000`. **Required in production** if any OAuth provider is configured.

### `auth.apiKeys`

Controls expiration policy for user-generated API keys.

| Option | Default | Description |
|---|---|---|
| `defaultExpirationDays` | `365` | TTL when no `expiresInDays` is passed at key creation. `0` = keys never expire by default. |
| `maxExpirationDays` | `null` | Hard ceiling. Keys cannot be created with a longer TTL. `null` = no cap. |

`defaultExpirationDays` cannot exceed `maxExpirationDays` — BunBase throws on startup if misconfigured. See the [API Keys](/api/api-keys/) guide for endpoint details.

### `storage.driver`

Choose between `"local"` (filesystem) and `"s3"` (S3-compatible object storage).

### `storage.maxFileSize`

Maximum upload size in bytes. Requests exceeding this are rejected with a 400 error.

Default: `10485760` (10 MB)

### `storage.allowedMimeTypes`

When set, only files matching these MIME types are accepted. When unset, all types are allowed.

### `cors.origins`

List of allowed CORS origins. **Required in production** — BunBase will throw an error on startup if not configured.

In development mode, all origins are allowed regardless of this setting.

### `realtime.enabled`

When `true`, BunBase opens a WebSocket endpoint at `/realtime` for live table subscriptions, broadcast channels, and presence. See the [Realtime](/realtime/) guide.

Default: `false`

### `trustedProxies`

A list of IP addresses for trusted reverse proxies (exact match — CIDR ranges are not supported). When a request arrives from one of these IPs, BunBase will trust the `X-Forwarded-For` and `X-Real-IP` headers for rate limiting, using the forwarded client IP as the rate-limit key.

When unset (the default), forwarded headers are ignored entirely and the raw socket IP is used. This is the safe default for deployments without a reverse proxy.

Set this if you run BunBase behind nginx, Cloudflare Tunnel, or any load balancer that rewrites the client IP:

```ts
defineConfig({
  trustedProxies: ["127.0.0.1"], // local nginx
})
```

Default: `[]`

### `cookieDomain`

Sets the `Domain` attribute on session, CSRF, and OAuth state cookies.

Use a dot-prefixed parent domain to share cookies across subdomains:

```ts
defineConfig({
  cookieDomain: process.env.COOKIE_DOMAIN, // e.g. ".example.com"
})
```

This is needed when the BunBase API server and the frontend are on different subdomains (e.g. `api.example.com` and `app.example.com`). Without it, cookies are scoped to the exact host that sets them.

**Also required:** Configure `cors.origins` with the frontend origin, and ensure your frontend makes requests with `credentials: "include"`.

Default: unset (cookies scoped to exact host)

## Environment variables

BunBase reads these environment variables:

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Set to `"production"` for production mode |
| `PORT` | Server port (default: 3000) |
| `BUNBASE_ADMIN_EMAIL` | Email for the admin account created on first startup (production only) |
| `BUNBASE_ADMIN_PASSWORD` | Password for the admin account created on first startup (production only) |

> **Note:** `trustedProxies` is a code-level config option, not an environment variable. Set it in your `defineConfig()` call.

Bun automatically loads `.env` files — no dotenv needed.

## Next steps

- [API Keys](/api/api-keys/) — user-generated bearer tokens
- [Extending](/extending/) — add custom REST routes
- [Deployment](/deployment/) — production checklist
