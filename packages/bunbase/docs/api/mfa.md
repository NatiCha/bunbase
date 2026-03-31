---
title: MFA / Two-Factor Auth
---

BunBase supports TOTP-based two-factor authentication with backup codes. When MFA is enabled, the login flow adds a second step — users must enter a code from their authenticator app before gaining full access.

## Configuration

```ts
defineConfig({
  auth: {
    mfa: {
      encryptionKey: process.env.BUNBASE_MFA_SECRET, // required in production
      totp: {
        enabled: true,
        issuer: "My App", // shown in authenticator apps
        window: 1,        // verification window (default: 1 period)
      },
      backupCodes: {
        count: 10,  // number of codes (default: 10)
        length: 8,  // characters per code (default: 8)
      },
    },
  },
});
```

The `encryptionKey` (or `BUNBASE_MFA_SECRET` env var) encrypts TOTP secrets at rest with AES-256-GCM. In development, a fallback key is used with a console warning.

## TOTP setup flow

### 1. Generate secret

```
POST /auth/mfa/totp/setup
```

Requires an authenticated session. Returns a secret and `otpauth://` URI for QR code scanning.

**Response (200):**

```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "uri": "otpauth://totp/My%20App:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=My%20App&algorithm=SHA1&digits=6&period=30"
}
```

### 2. Confirm setup

```
POST /auth/mfa/totp/verify-setup
```

Submit a code from the authenticator app to confirm enrollment. Returns single-use backup codes.

**Request body:**

| Field | Type | Required |
|---|---|---|
| `code` | `string` (6 digits) | Yes |

**Response (200):**

```json
{
  "backupCodes": ["a3k9m2x7", "p8n4v6b2", "..."]
}
```

Store these codes safely — they are shown only once.

## Login with MFA

When a user with TOTP enabled logs in via `POST /auth/login`, the response changes:

```json
{
  "mfaRequired": true,
  "mfaMethods": ["totp"]
}
```

A session cookie is set, but the session is **pending** — it cannot access any API routes except `/auth/mfa/*` and `/auth/logout`.

### Complete MFA challenge

```
POST /auth/mfa/totp/verify
```

**Request body:**

| Field | Type | Required |
|---|---|---|
| `code` | `string` (6 digits) | Yes |

**Response (200):**

```json
{
  "user": { "id": "...", "email": "alice@example.com", "role": "user" }
}
```

The session is upgraded to fully verified. All API routes are now accessible.

### Use a backup code

```
POST /auth/mfa/backup/verify
```

**Request body:**

| Field | Type | Required |
|---|---|---|
| `code` | `string` | Yes |

Each backup code is single-use. After consumption it cannot be used again.

## Management

### Check MFA status

```
GET /auth/mfa/status
```

**Response (200):**

```json
{ "totp": true, "passkeys": 0 }
```

### Disable TOTP

```
POST /auth/mfa/totp/disable
```

Requires the user's password for confirmation. Deletes the TOTP secret and all backup codes.

| Field | Type | Required |
|---|---|---|
| `password` | `string` | Yes |

### Regenerate backup codes

```
POST /auth/mfa/backup/regenerate
```

Requires the user's password. Replaces all existing backup codes with new ones.

| Field | Type | Required |
|---|---|---|
| `password` | `string` | Yes |

**Response (200):**

```json
{ "backupCodes": ["new-code-1", "new-code-2", "..."] }
```

## Client SDK

```ts
// Setup
const { secret, uri } = await client.auth.mfa.setup();
// Show QR code from `uri`, user scans it

// Confirm with code from authenticator
const { backupCodes } = await client.auth.mfa.verifySetup("123456");

// Login flow
const result = await client.auth.login({ email, password });
if ("mfaRequired" in result) {
  const { user } = await client.auth.mfa.verify("123456");
}

// Or use backup code
const { user } = await client.auth.mfa.verifyBackup("a3k9m2x7");

// Check status
const status = await client.auth.mfa.status();

// Disable
await client.auth.mfa.disable("current-password");
```

## Hooks

```ts
defineAuthHooks({
  afterMfaSetup: ({ userId, method }) => { /* method is "totp" */ },
  afterMfaVerify: ({ userId, method }) => { /* "totp" or "backup_code" */ },
  afterMfaDisable: ({ userId, method }) => { /* method is "totp" */ },
});
```

## Next steps

- [Passkeys](/api/passkeys/) — WebAuthn as an alternative second factor or primary auth
- [Passwordless](/api/passwordless/) — magic links and email OTP
