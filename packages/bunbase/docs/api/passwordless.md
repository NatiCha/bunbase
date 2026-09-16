---
title: Passwordless Auth
---

BunBase supports two passwordless authentication methods: **magic links** and **email OTP**. Both use the existing mailer infrastructure and verification token system.

## Configuration

```ts
defineConfig({
  auth: {
    mfa: {
      magicLink: {
        enabled: true,
        ttl: 600, // token TTL in seconds (default: 10 minutes)
      },
      otp: {
        enabled: true,
        ttl: 300,    // code TTL in seconds (default: 5 minutes)
        length: 6,   // number of digits (default: 6)
      },
    },
  },
});
```

Both methods require a [mailer](/email/) to be configured for sending emails. In development mode, tokens and codes are logged to the console.

## Magic links

A magic link is a one-time URL sent to the user's email. Clicking it authenticates the user without a password.

### Request a magic link

```
POST /auth/magic-link/request
```

```bash
curl -X POST http://localhost:3000/auth/magic-link/request \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

**Response (200):**

```json
{
  "message": "If an account with that email exists, a sign-in link has been sent."
}
```

Always returns 200 to prevent user enumeration.

### Verify (browser)

```
GET /auth/magic-link/verify?token=<token>
```

When the user clicks the link in their email, they're authenticated and shown a success page. Session cookies are set automatically.

### Verify (API)

```
POST /auth/magic-link/verify
```

```bash
curl -X POST http://localhost:3000/auth/magic-link/verify \
  -H "Content-Type: application/json" \
  -d '{"token": "magic-link-token"}' \
  -c cookies.txt
```

**Response (200):**

```json
{
  "user": { "id": "...", "email": "alice@example.com", "role": "user" }
}
```

**Errors:**
- `400` — invalid or expired token

## Email OTP

An OTP (one-time password) is a short numeric code sent to the user's email. The user types the code to authenticate.

### Request an OTP

```
POST /auth/otp/request
```

```bash
curl -X POST http://localhost:3000/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

**Response (200):**

```json
{
  "message": "If an account with that email exists, a code has been sent."
}
```

### Verify an OTP

```
POST /auth/otp/verify
```

```bash
curl -X POST http://localhost:3000/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "code": "483921"}' \
  -c cookies.txt
```

**Response (200):**

```json
{
  "user": { "id": "...", "email": "alice@example.com", "role": "user" }
}
```

**Errors:**
- `401` — invalid email or code
- `429` — rate limited

## Client SDK

```ts
// Magic link
await client.auth.magicLink.request("alice@example.com");
// User clicks the link in their email, or:
const result = await client.auth.magicLink.verify(token);
if ("mfaRequired" in result) {
  // Prompt for the authenticator code, then complete login:
  await client.auth.mfa.verify(authenticatorCode);
} else {
  console.log(result.user);
}

// Email OTP
await client.auth.otp.request("alice@example.com");
const otpResult = await client.auth.otp.verify("alice@example.com", "483921");
// Handle the same MFA challenge or user result as above.
```

For users with TOTP enrolled, both verification methods return
`{ mfaRequired: true, mfaMethods: ["totp"] }` instead of `{ user }`. The SDK types
reflect both outcomes; `onAuthStateChange` reports a login only after MFA completes.

## Security notes

- Tokens and codes are stored as SHA-256 hashes — the raw value is never persisted
- Previous tokens for the same user and type are invalidated when a new one is requested
- All request endpoints return identical responses regardless of whether the email exists
- Rate limiting applies to both request and verify endpoints

## Hooks

```ts
defineAuthHooks({
  beforeMagicLinkLogin: ({ email, req }) => { /* reject or allow */ },
  afterMagicLinkLogin: ({ user, userId, isNewUser }) => { /* side effects */ },
  beforeOtpLogin: ({ email, req }) => { /* reject or allow */ },
  afterOtpLogin: ({ user, userId }) => { /* side effects */ },
});
```

## Next steps

- [Auth API](/api/auth/) — email/password and OAuth authentication
- [MFA](/api/mfa/) — add TOTP two-factor authentication
- [Email](/email/) — configure the mailer for sending tokens
