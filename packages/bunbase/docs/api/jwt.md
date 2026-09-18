---
title: "JWT Mode"
---

# JWT Mode

JWT bearer tokens alongside server-side cookie sessions. Useful for mobile clients, third-party API consumers, or any context where cookies are impractical.

## Configuration

```ts
createServer({
  config: defineConfig({
    auth: {
      jwt: {
        enabled: true,
        secret: process.env.JWT_SECRET,   // or set BUNBASE_JWT_SECRET env var
        issuer: "https://api.example.com",
        audience: "example-mobile-app",
        accessTokenTtl: 900,              // 15 minutes, default
        refreshTokenTtl: 604800,          // 7 days, default
      },
    },
  }),
});
```

`secret` is required in production (falls back to `BUNBASE_JWT_SECRET` env var). BunBase will throw at startup if JWT mode is enabled in production without a secret.

## How it works

Applications can issue JWTs using the exported `signJwt` helper when JWT mode is enabled. The built-in login/register/passwordless/passkey routes currently set cookie sessions. An application-provided token response can use this shape:

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

BunBase detects JWT tokens in the Bearer header (3-dot format) and verifies them using HMAC-SHA256 using this server instance's configured secret. Each request checks revocation state and loads the current user, so deleted accounts and stale roles cannot retain access.

## JWT payload

```json
{
  "iss": "https://api.example.com",
  "aud": "example-mobile-app",
  "fid": "token-family-id",
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
{ "accessToken": "eyJ...", "refreshToken": "eyJ...", "expiresIn": 900 }
```

## Token revocation

BunBase maintains a `_jwt_revocations` table. Logout invalidates all JWTs previously issued for the authenticated user, including refresh tokens; it also removes the current cookie session. Password reset, password change, and account deletion invalidate all of the user's existing sessions and JWTs. Other users' tokens remain valid.

User revocation cutoffs are persistent and monotonic, including for application-issued tokens with custom lifetimes. Fresh tokens issued after revocation can authenticate again. Refresh rechecks the original issuance time against user revocation after signing to prevent racing a revocation. Server instances that share authentication data should keep their clocks synchronized.

`verifyJwt(token, secret, db, internalSchema, { issuer, audience })` checks claims and database revocations. Without explicit expectations, the helper expects the development values `bunbase` for both claims. Production JWT configuration requires explicit issuer and audience; applications issuing tokens with `signJwt` must pass matching `iss` and `aud`, plus the same random `fid` for an access/refresh pair. Tokens missing these claims must be replaced by signing in again.

## Client SDK

Browser applications should use BunBase's HttpOnly cookie sessions. Do not persist refresh tokens in localStorage, sessionStorage, IndexedDB, or JavaScript-readable cookies. For native applications, keep tokens in the platform's secure credential store; a browser backend-for-frontend can keep them server-side.

```ts
// Native client: serialize refresh requests and replace the stored pair atomically.
const { accessToken, refreshToken: nextRefreshToken, expiresIn } =
  await client.auth.refresh(currentRefreshToken);
// Save nextRefreshToken in your platform's secure credential store.
```

Refresh tokens are single-use. Reusing one revokes its entire family, including already-issued access tokens. A lost refresh response or concurrent refresh requires signing in again; do not retry with the old token. Rotation retains the original refresh expiration, and does not create an unlimited sliding session.

## Mixing JWT and cookie sessions

JWT mode does **not** disable cookie sessions. You can use bearer tokens for mobile and cookie sessions for the web app simultaneously. BunBase resolves auth from whichever is present:
1. Session cookie (if present)
2. Bearer JWT token
3. Bearer API key

## Algorithm

BunBase uses **HMAC-SHA256** (HS256) via the Web Crypto API (`crypto.subtle`). No third-party JWT library is required. Asymmetric algorithms (RS256, ES256) are not currently supported.
