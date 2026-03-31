# Invitation System

Invite-only registration with single-use or multi-use invite codes/links.

## Configuration

```ts
createServer({
  config: defineConfig({
    auth: {
      invitations: {
        enabled: true,          // default: false
        required: false,        // if true, register requires inviteCode, default: false
        ttl: 604800,            // invite TTL in seconds, default: 604800 (7 days)
        maxUsesDefault: 1,      // default max uses per invite, default: 1
      },
    },
  }),
});
```

## Endpoints

### POST /auth/invites _(admin only)_

Create an invite. Requires CSRF.

```json
{
  "email": "alice@example.com",   // optional — if set, only this email can use it
  "role": "user",                  // role assigned on accept, default: "user"
  "maxUses": 5                     // how many times the invite can be used
}
```

**Response:**
```json
{
  "invite": {
    "id": "...",
    "token": "01234567-...",   // only returned once at creation — share this
    "email": "alice@example.com",
    "role": "user",
    "maxUses": 5,
    "expiresAt": 1775000000
  }
}
```

### GET /auth/invites _(admin only)_

List all invites.

### DELETE /auth/invites/:id _(admin only, CSRF required)_

Delete an invite. Returns `{ "deleted": true }`.

### POST /auth/invites/validate _(public, CSRF-exempt)_

Check if a token is valid without consuming it.

```json
{ "token": "01234567-..." }
```

**Response:**
```json
{ "valid": true, "email": "alice@example.com" }
```

## Invite-required registration

When `invitations.required: true`, the register endpoint requires an `inviteCode` field:

```json
{
  "email": "alice@example.com",
  "password": "secret",
  "inviteCode": "01234567-..."
}
```

If the code is invalid, missing, or email-mismatched, registration returns `400`.

## Hooks

```ts
defineAuthHooks({
  afterInviteCreate: async ({ inviteId, email, invitedBy }) => {
    await sendInviteEmail(email, inviteId);
  },
});
```

## Client SDK

```ts
// Create invite (admin)
const { invite } = await client.auth.invites.create({ email: "alice@example.com" });

// List invites (admin)
const { invites } = await client.auth.invites.list();

// Delete invite (admin)
await client.auth.invites.delete(inviteId);

// Validate token (public — e.g. on the registration page)
const { valid, email } = await client.auth.invites.validate(token);

// Register with invite code
await client.auth.register({ email, password, inviteCode: token });
```
