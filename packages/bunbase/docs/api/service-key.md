---
title: Service Key
---

A service key provides server-to-server admin access without requiring a user account. It's useful for deployment automation, CI/CD pipelines, and hub services that need to call BunBase APIs before any user exists.

## How it works

- The service key is a startup config, not a database entity — it's never stored in the database
- Requests authenticated with a service key receive a synthetic admin user: `{ id: "__service__", email: "", role: "admin" }`
- Service key auth is the highest priority — checked before session cookies, JWT, and user API keys
- Rules that use the `admin(auth)` helper will pass for service key requests
- All `/_admin/api/*` endpoints are accessible with a service key
- The key never expires

## Key format

```
bb_sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

Prefixed with `bb_sk_` to distinguish from user API keys (`bb_live_`).

## Configuration

Provide the key explicitly, or let BunBase auto-generate one:

### Option 1: Environment variable

```bash
BUNBASE_SERVICE_KEY=bb_sk_your_custom_key_here_32hex
```

### Option 2: Config

```ts
defineConfig({
  serviceKey: "bb_sk_your_custom_key_here_32hex",
});
```

### Option 3: Auto-generated (default)

If neither config nor env var is set, BunBase will:

1. Check for an existing `.bunbase-service-key` file in the working directory
2. If not found, generate a cryptographically random key and persist it to `.bunbase-service-key`
3. Print the key to console on startup

The `.bunbase-service-key` file is automatically included in `.gitignore` when scaffolding with `bunbase init`.

## Using the service key

Send the key as a Bearer token:

```ts
const res = await fetch("https://your-app.com/_admin/api/users", {
  headers: {
    Authorization: "Bearer bb_sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  },
});
```

No cookies, no CSRF token needed.

### Client SDK

The existing `apiKey` option works with service keys — no changes needed:

```ts
import { createBunBaseClient } from "bunbase/client";

const client = createBunBaseClient({
  url: "https://your-app.com",
  schema,
  apiKey: process.env.BUNBASE_SERVICE_KEY,
});

const users = await client.api.users.list();
```

## Service key vs. user API keys

| | Service key | User API key |
|---|---|---|
| **Prefix** | `bb_sk_` | `bb_live_` |
| **Requires user account** | No | Yes |
| **Stored in database** | No | Yes (SHA-256 hash) |
| **Expires** | Never | Configurable |
| **Auth identity** | Synthetic admin (`__service__`) | Real user |
| **Use case** | Server-to-server, CI/CD, bootstrapping | User scripts, CLI tools |

## Checking for service key in extend routes

If you need to distinguish service key requests in custom routes:

```ts
import { isServiceKey, SERVICE_KEY_USER } from "bunbase";

extend: ({ extractAuth }) => ({
  "/api/my-route": {
    async POST(req) {
      const user = await extractAuth(req);
      if (user?.id === "__service__") {
        // Service key request
      }
    },
  },
}),
```

## Security notes

- Keep the service key secret — it grants full admin access
- Add `.bunbase-service-key` to `.gitignore` (done automatically by `bunbase init`)
- In production, prefer setting the key via `BUNBASE_SERVICE_KEY` env var rather than hardcoding in config
- The key is compared using constant-time comparison to prevent timing attacks
