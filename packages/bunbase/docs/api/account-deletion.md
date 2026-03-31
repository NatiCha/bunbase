# Account Deletion

GDPR-compliant cascading account deletion. Enabled by default.

## Configuration

```ts
createServer({
  config: defineConfig({
    auth: {
      accountDeletion: {
        enabled: true,          // default: true
        requirePassword: true,  // default: true — ask for password before deleting
      },
    },
  }),
});
```

## Endpoint

### POST /auth/delete-account

Requires an active session and CSRF token.

**Request (when `requirePassword: true`):**
```json
{ "password": "currentpassword" }
```

**Request (when `requirePassword: false`):**
```json
{}
```

**Response:**
```json
{ "deleted": true }
```

Session and CSRF cookies are cleared in the response.

## What gets deleted

In order:
1. All `_sessions` for the user
2. All `_api_keys` for the user
3. All `_verification_tokens` for the user
4. All `_oauth_accounts` for the user
5. All `_mfa_totp` records for the user
6. All `_mfa_backup_codes` for the user
7. All `_passkey_credentials` for the user
8. All `_organization_members` for the user (if organizations enabled)
9. The user row itself

## Hooks

```ts
defineAuthHooks({
  beforeAccountDelete: async ({ userId, req }) => {
    // Throw ApiError to abort deletion
    await cleanupExternalData(userId);
  },
  afterAccountDelete: async ({ userId, email }) => {
    await sendGoodbyeEmail(email);
  },
});
```

## Client SDK

```ts
// With password confirmation
await client.auth.deleteAccount("mypassword");

// Without password (when requirePassword: false)
await client.auth.deleteAccount();
```
