---
title: Passkeys (WebAuthn)
---

BunBase supports passkey authentication via the WebAuthn/FIDO2 standard. Passkeys provide phishing-resistant, passwordless login using biometrics, security keys, or device credentials.

## Prerequisites

Passkeys require the `@simplewebauthn/server` peer dependency:

```bash
bun add @simplewebauthn/server
```

On the client side, you'll also need `@simplewebauthn/browser` for the browser WebAuthn API:

```bash
bun add @simplewebauthn/browser
```

## Configuration

```ts
defineConfig({
  auth: {
    mfa: {
      passkeys: {
        enabled: true,
        rpName: "My App",                   // relying party display name
        rpId: "example.com",                // relying party ID (your domain)
        origin: "https://example.com",      // expected origin
        authenticatorAttachment: "platform", // optional — see below
      },
    },
  },
});
```

In development, `rpId` and `origin` default to the request's hostname and origin.

### `authenticatorAttachment`

Controls which type of authenticator is allowed for passkey registration and preferred during login:

| Value | Behavior |
|---|---|
| `"platform"` | Only built-in authenticators: Touch ID, Face ID, Windows Hello, iCloud Keychain. Prevents QR code prompts for cross-device authentication. |
| `"cross-platform"` | Only roaming authenticators: hardware security keys, phones via QR code. |
| `undefined` (default) | Allow both — the browser decides what to show. |

Set `"platform"` if your users primarily sign in from their own devices and you want the cleanest UX (biometric prompt, no QR code).

## Registration flow

An authenticated user registers a passkey in two steps.

### 1. Get registration options

```
POST /auth/passkeys/register/options
```

Returns WebAuthn registration options. Requires an authenticated session.

**Response (200):**

```json
{
  "challenge": "...",
  "rp": { "name": "My App", "id": "example.com" },
  "user": { "id": "...", "name": "alice@example.com", "displayName": "alice@example.com" },
  "pubKeyCredParams": [...],
  "excludeCredentials": [...]
}
```

### 2. Verify registration

```
POST /auth/passkeys/register/verify
```

Submit the attestation response from the browser's `navigator.credentials.create()`.

**Request body:**

| Field | Type | Required |
|---|---|---|
| `response` | `object` | Yes — the raw WebAuthn attestation response |
| `name` | `string` | No — display name for the passkey (default: "Passkey") |

**Response (200):**

```json
{ "verified": true, "credentialId": "..." }
```

### Client-side example

```ts
import { startRegistration } from "@simplewebauthn/browser";

// 1. Get options from server
const options = await client.auth.passkeys.registerOptions();

// 2. Create credential in browser
const attestation = await startRegistration(options);

// 3. Verify with server
const result = await client.auth.passkeys.registerVerify(attestation, "MacBook Touch ID");
```

## Authentication flow

Passkey login works without an existing session — it's a primary authentication method.

### 1. Get authentication options

```
POST /auth/passkeys/login/options
```

**Request body (optional):**

| Field | Type | Required |
|---|---|---|
| `email` | `string` | No — narrows to a specific user's credentials |

**Response (200):**

```json
{
  "challenge": "...",
  "allowCredentials": [...],
  "rpId": "example.com"
}
```

### 2. Verify authentication

```
POST /auth/passkeys/login/verify
```

Submit the assertion response from the browser's `navigator.credentials.get()`.

**Response (200):**

```json
{
  "user": { "id": "...", "email": "alice@example.com", "role": "user" }
}
```

Sets session cookies. Passkey login creates a **fully verified** session — it satisfies MFA requirements if TOTP is also enrolled.

### Client-side example

```ts
import { startAuthentication } from "@simplewebauthn/browser";

// 1. Get options
const options = await client.auth.passkeys.loginOptions();

// 2. Authenticate in browser
const assertion = await startAuthentication(options);

// 3. Verify with server
const { user } = await client.auth.passkeys.loginVerify(assertion);
```

## Management

### List passkeys

```
GET /auth/passkeys
```

**Response (200):**

```json
{
  "passkeys": [
    {
      "id": "credential-id",
      "name": "MacBook Touch ID",
      "deviceType": "multiDevice",
      "backedUp": 1,
      "createdAt": "2024-01-15T...",
      "lastUsedAt": "2024-01-20T..."
    }
  ]
}
```

### Remove a passkey

```
POST /auth/passkeys/delete
```

| Field | Type | Required |
|---|---|---|
| `id` | `string` | Yes — credential ID to remove |

**Response (200):**

```json
{ "deleted": true }
```

## Client SDK

```ts
// Registration (requires active session)
const options = await client.auth.passkeys.registerOptions();
const attestation = await startRegistration(options);
await client.auth.passkeys.registerVerify(attestation, "My Key");

// Authentication (no session required)
const loginOpts = await client.auth.passkeys.loginOptions();
const assertion = await startAuthentication(loginOpts);
const { user } = await client.auth.passkeys.loginVerify(assertion);

// Management
const { passkeys } = await client.auth.passkeys.list();
await client.auth.passkeys.remove("credential-id");
```

## Hooks

```ts
defineAuthHooks({
  afterPasskeyRegister: ({ userId, credentialId }) => { /* ... */ },
  afterPasskeyLogin: ({ userId, credentialId }) => { /* ... */ },
  afterPasskeyRemove: ({ userId, credentialId }) => { /* ... */ },
});
```

## Next steps

- [MFA](/api/mfa/) — TOTP two-factor authentication
- [Passwordless](/api/passwordless/) — magic links and email OTP
- [Auth API](/api/auth/) — email/password and OAuth authentication
