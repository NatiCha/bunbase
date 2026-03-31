# JWT Mode

Stateless JWT tokens instead of server-side cookie sessions. Useful for mobile clients, third-party API consumers, or any context where cookies are impractical.

## Configuration

```ts
createServer({
  config: defineConfig({
    auth: {
      jwt: {
        enabled: true,
        secret: process.env.JWT_SECRET,   // or set BUNBASE_JWT_SECRET env var
        accessTokenTtl: 900,              // 15 minutes, default
        refreshTokenTtl: 604800,          // 7 days, default
      },
    },
  }),
});
```

`secret` is required in production (falls back to `BUNBASE_JWT_SECRET` env var). BunBase will throw at startup if JWT mode is enabled in production without a secret.

## How it works

When JWT mode is enabled, login/register/passwordless/passkey responses return tokens instead of setting cookies:

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "expiresIn": 900,
  "user": { "id": "...", "email": "alice@example.com", "role": "user" }
}
```

The client stores the `accessToken` and sends it as a Bearer token:

```
Authorization: Bearer eyJ...
```

BunBase detects JWT tokens in the Bearer header (3-dot format) and verifies them using HMAC-SHA256 — no database lookup for each request.

## JWT payload

```json
{
  "sub": "user-id",
  "email": "alice@example.com",
  "role": "user",
  "jti": "unique-token-id",
  "iat": 1775000000,
  "exp": 1775000900,
  "type": "access"
}
```

## Refresh endpoint

Access tokens are short-lived. Use the refresh token to get a new access token without re-authenticating.

### POST /auth/refresh _(CSRF-exempt)_

```json
{ "refreshToken": "eyJ..." }
```

**Response:**
```json
{ "accessToken": "eyJ...", "expiresIn": 900 }
```

## Token revocation

BunBase maintains a `_jwt_revocations` table. Tokens are added to it on logout and password reset. Revoked tokens are checked on every JWT verification.

## Client SDK

```ts
// After login/register, store tokens yourself
const result = await client.auth.login({ email, password });
if ("accessToken" in result) {
  localStorage.setItem("refresh_token", result.refreshToken);
  // Set accessToken in client config for subsequent requests
}

// Refresh access token
const { accessToken, expiresIn } = await client.auth.refresh(refreshToken);
```

## Mixing JWT and cookie sessions

JWT mode does **not** disable cookie sessions. You can use bearer tokens for mobile and cookie sessions for the web app simultaneously. BunBase resolves auth from whichever is present:
1. Session cookie (if present)
2. Bearer JWT token
3. Bearer API key

## Algorithm

BunBase uses **HMAC-SHA256** (HS256) via the Web Crypto API (`crypto.subtle`). No third-party JWT library is required. Asymmetric algorithms (RS256, ES256) are not currently supported.
