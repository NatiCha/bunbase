---
title: API Keys
---

API keys let users authenticate without browser cookies — useful for server-to-server calls, CLI tools, and scripts. They use HTTP Bearer auth and bypass CSRF checks (no browser required).

## How it works

- Each key is owned by a user and carries their `id`, `email`, and `role`
- Rules and hooks see API key requests identically to cookie-based sessions — `auth` is populated the same way
- Session cookies take precedence: if both a session cookie and a Bearer token are present, the cookie wins
- Keys are stored as SHA-256 hashes — the raw key is only returned once at creation

## Key format

```
bb_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
         ^^^^^^^^                           (keyPrefix — shown in list responses for identification)
```

Prefixed with `bb_live_` for easy scanning in code and logs.

## Endpoints

### Create a key

```
POST /auth/api-keys
```

Requires an active session (cookie or existing bearer token). Returns the raw key only once — store it securely.

**Request body:**

```json
{
  "name": "My CI key",
  "expiresInDays": 90
}
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` (required) | Label for the key |
| `expiresInDays` | `number` (optional) | TTL in days. Omit to use the server default. Pass `0` for no expiration. |

**Response `201`:**

```json
{
  "id": "0196a1b2-...",
  "name": "My CI key",
  "keyPrefix": "bb_live_a1b2c3d4",
  "key": "bb_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "expiresAt": 1760000000,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

`expiresAt` is a Unix timestamp in seconds, or `null` if the key never expires. `key` is not returned again after this response.

### List keys

```
GET /auth/api-keys
```

Returns all keys belonging to the authenticated user. The `key` field is never included — only `keyPrefix` for identification.

**Response `200`:**

```json
[
  {
    "id": "0196a1b2-...",
    "userId": "user-id",
    "keyPrefix": "bb_live_a1b2c3d4",
    "name": "My CI key",
    "expiresAt": 1760000000,
    "lastUsedAt": "2026-02-01T12:00:00.000Z",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

`lastUsedAt` is updated at most once per 5 minutes to avoid write amplification.

### Revoke a key

```
DELETE /auth/api-keys/:id
```

The owning user or an admin can revoke any key. Returns `{ "deleted": true }`.

## Using an API key

Send the key as a Bearer token in the `Authorization` header:

```ts
const res = await fetch("https://your-app.com/api/posts", {
  headers: {
    Authorization: "Bearer bb_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  },
});
```

No cookies, no CSRF token needed.

### Client SDK

Pass `apiKey` when creating the client — this switches the client from cookie-based auth to Bearer auth automatically:

```ts
const client = createBunBaseClient({
  url: "https://your-app.com",
  schema,
  apiKey: process.env.BUNBASE_API_KEY,
});

// Works identically to cookie-based client
const posts = await client.api.posts.list();
```

With `apiKey` set, the client omits `credentials: "include"` and `X-CSRF-Token` on all requests.

## Server configuration

Configure key expiration policy in `defineConfig`:

```ts
defineConfig({
  auth: {
    apiKeys: {
      // Default TTL for new keys. 0 = no expiration by default. (default: 365)
      defaultExpirationDays: 90,
      // Hard cap — keys cannot be created with a longer TTL. (default: null = no cap)
      maxExpirationDays: 365,
    },
  },
})
```

| Option | Default | Description |
|---|---|---|
| `defaultExpirationDays` | `365` | TTL applied when no `expiresInDays` is passed. `0` = keys are infinite by default. |
| `maxExpirationDays` | `null` | Hard ceiling on TTL. `null` = no cap. Must be `>= 1`. |

`defaultExpirationDays` cannot exceed `maxExpirationDays` — BunBase throws on startup if misconfigured.

## Creating a key from the client

```ts
const res = await fetch("/auth/api-keys", {
  method: "POST",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": getCsrfToken(),
  },
  body: JSON.stringify({ name: "My key", expiresInDays: 90 }),
});

const { key, keyPrefix, id, expiresAt } = await res.json();
// Save `key` now — it will not be shown again
```
