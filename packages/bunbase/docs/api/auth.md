---
title: Auth API
---

BunBase provides built-in authentication via HTTP endpoints. Auth uses session cookies — no token management required on the client.

## Endpoints

### Register

```
POST /auth/register
```

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "secret123"}' \
  -c cookies.txt
```

**Request body:**

| Field | Type | Required |
|---|---|---|
| `email` | `string` | Yes |
| `password` | `string` (min 8 chars) | Yes |
| *additional fields* | varies | If `notNull` without default on users table |

If your `users` table has extra `notNull` columns without defaults, they become required during registration:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "secret123", "name": "Alice"}'
```

**Response (201):**

```json
{
  "user": {
    "id": "...",
    "email": "alice@example.com",
    "role": "user",
    "name": "Alice"
  }
}
```

Sets `bunbase_session` and `csrf_token` cookies. Fields like `password_hash` are never returned.

**Errors:**
- `400` — invalid input or blocked fields (`id`, `role`, `passwordHash`)
- `409` — email already registered
- `429` — rate limited

### Login

```
POST /auth/login
```

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "secret123"}' \
  -c cookies.txt
```

**Response (200):**

```json
{
  "user": {
    "id": "...",
    "email": "alice@example.com",
    "role": "user"
  }
}
```

**Errors:**
- `401` — invalid credentials, or account uses OAuth only
- `429` — rate limited

### Logout

```
POST /auth/logout
```

```bash
curl -X POST http://localhost:3000/auth/logout \
  -H "X-CSRF-Token: <csrf-token>" \
  -b cookies.txt
```

Requires a valid CSRF token. Clears the session and CSRF cookies.

**Response (200):**

```json
{ "success": true }
```

### Get current user

```
GET /auth/me
```

```bash
curl http://localhost:3000/auth/me -b cookies.txt
```

**Response (200):**

```json
{
  "user": {
    "id": "...",
    "email": "alice@example.com",
    "role": "user"
  }
}
```

**Errors:**
- `401` — not authenticated

## Password reset

Password reset uses a two-step flow: request a reset token, then submit the new password with the token.

### Request password reset

```
POST /auth/request-password-reset
```

```bash
curl -X POST http://localhost:3000/auth/request-password-reset \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

**Response (200):**

```json
{
  "message": "If an account with that email exists, a reset link has been sent."
}
```

Always returns success to prevent user enumeration. When a mailer is configured, password reset emails are sent automatically — no webhook required. In development mode (no mailer, no webhook), the reset token is logged to the console. In production without a mailer, BunBase POSTs to your configured `auth.email.webhook`:

```json
{
  "type": "password_reset",
  "email": "alice@example.com",
  "token": "reset-token-uuid",
  "userId": "user-id"
}
```

### Reset password

```
POST /auth/reset-password
```

```bash
curl -X POST http://localhost:3000/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{"token": "reset-token-uuid", "password": "newpassword123"}' \
  -c cookies.txt
```

**Response (200):**

```json
{ "message": "Password reset successfully" }
```

Invalidates all existing sessions and creates a new one. Sets session and CSRF cookies.

**Errors:**
- `400` — invalid or expired token (tokens expire after 1 hour)

### Verify email

```
POST /auth/verify-email
```

```bash
curl -X POST http://localhost:3000/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"token": "verification-token"}'
```

Sets `email_verified = 1` on the user record (if the column exists). Tokens expire after 24 hours.

**Errors:**
- `400` — invalid or expired token

### Request email verification

```
POST /auth/request-email-verification
```

Sends a fresh email verification link to the given address. Requires a mailer to be configured.

```bash
curl -X POST http://localhost:3000/auth/request-email-verification \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

**Request body:**

| Field | Type | Required |
|---|---|---|
| `email` | `string` | Yes |

**Response (200):**

```json
{
  "message": "If an account with that email exists, a verification link has been sent."
}
```

Always returns 200 to prevent user enumeration. Previous tokens for the same user are invalidated before a new one is created.

**Errors:**
- `400` — invalid input
- `429` — rate limited
- `503` — no mailer configured

When a user registers and the `users` table has an `emailVerified` column, BunBase automatically sends a verification email (fire-and-forget) if a mailer is configured and `auth.emailVerification.autoSend` is `true` (the default). See [Email](/email/) for setup details.

## OAuth

BunBase supports Google, GitHub, and Discord OAuth. Configure providers in your config:

```ts
defineConfig({
  auth: {
    oauth: {
      redirectUrl: "https://your-app.com", // required in production
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
    },
  },
});
```

### OAuth flow

1. Redirect the user to `GET /auth/oauth/<provider>` (e.g. `/auth/oauth/google`)
2. BunBase redirects to the provider's consent screen
3. After consent, the provider redirects to `/auth/oauth/<provider>/callback`
4. BunBase creates or links the user account, sets session cookies, and redirects to `redirectUrl`

Available providers: `google`, `github`, `discord`.

If a user with the same email already exists, the OAuth account is linked to the existing user. If the user is new, a user record is created automatically.

### From a frontend

```ts
// Redirect the user to start OAuth
window.location.href = "http://localhost:3000/auth/oauth/google";
```

Or use the client SDK:

```ts
window.location.href = client.auth.oauthUrl("google");
```

## Session details

- Sessions are stored server-side in SQLite
- Session cookie name: `bunbase_session`
- CSRF cookie name: `csrf_token`
- Default session TTL: 30 days (configurable via `auth.tokenExpiry`)
- Auth endpoints are rate-limited per IP

## Auth event hooks

BunBase supports lifecycle hooks for auth events — run custom code before or after registration, login, OAuth, password reset, and email verification.

```ts
import { defineAuthHooks, ApiError } from "bunbase";

export const authHooks = defineAuthHooks({
  beforeRegister: async ({ email, data }) => {
    if (!email.endsWith("@company.com")) {
      throw new ApiError("FORBIDDEN", "Registration is invite-only", 403);
    }
    return { ...data, tier: "free" };
  },

  afterRegister: async ({ user }) => {
    await sendWelcomeEmail(user.email as string);
  },

  afterOAuthLogin: async ({ user, provider, isNewUser }) => {
    if (isNewUser) await createOnboardingRecord(user.id as string);
  },
});
```

Pass `authHooks` to `createServer`:

```ts
const bunbase = createServer({ schema, rules, hooks, authHooks });
```

See [Hooks](/hooks/) for the full auth hook surface, context types, and error handling rules.

## Next steps

- [Client SDK](/client/) — use `auth.login()`, `auth.register()` from the frontend
- [Rules](/rules/) — use `ctx.auth` in rules to check authentication
- [Hooks](/hooks/) — run code before/after auth events
