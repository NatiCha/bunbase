# Guest / Anonymous Auth

Create temporary sessions without requiring signup. Guest sessions can be converted to real accounts.

## Configuration

```ts
createServer({
  config: defineConfig({
    auth: {
      guestAuth: {
        enabled: true,    // default: false
        ttl: 86400,       // guest session TTL in seconds, default: 86400 (24h)
      },
    },
  }),
});
```

## Endpoints

### POST /auth/guest

Creates a guest session with a synthetic user ID (`guest:<uuid>`). No email or password required. CSRF-exempt.

**Response:**
```json
{ "guestId": "01234567-..." }
```

Also sets session and CSRF cookies.

### POST /auth/guest/convert

Converts the current guest session into a real account. Requires an active guest session cookie. CSRF-exempt.

**Request:**
```json
{ "email": "alice@example.com", "password": "newpassword" }
```

**Response:**
```json
{ "user": { "id": "...", "email": "alice@example.com", "role": "user" } }
```

The session is upgraded in-place: the same session cookie remains valid but now points to the real user.

## Identifying guests in rules

Guest users have `auth.role === "guest"`:

```ts
rules: {
  items: defineRules(schema.items, {
    list: ({ auth }) => auth !== null,           // allow both guests and real users
    create: ({ auth }) => auth?.role !== "guest", // only real users
  }),
}
```

## Hooks

```ts
defineAuthHooks({
  afterGuestCreate: async ({ guestId }) => {
    console.log("Guest created:", guestId);
  },
  afterGuestConvert: async ({ guestId, userId, email }) => {
    await migrateGuestData(guestId, userId);
  },
});
```

## Client SDK

```ts
// Create a guest session
const { guestId } = await client.auth.guest.create();

// Later, convert to a real account
const { user } = await client.auth.guest.convert({
  email: "alice@example.com",
  password: "newpassword",
});
```
