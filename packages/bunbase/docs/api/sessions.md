# Session Management

List active sessions and revoke them from other devices. Always available — no config required.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/sessions` | Yes | List all active sessions for the current user |
| `DELETE` | `/auth/sessions/:id` | Yes + CSRF | Revoke a specific session |
| `POST` | `/auth/sessions/revoke-others` | Yes + CSRF | Revoke all sessions except the current one |

### GET /auth/sessions

Returns all non-expired sessions for the authenticated user.

```json
{
  "sessions": [
    {
      "id": "01234567-...",
      "createdAt": "2026-03-01T10:00:00.000Z",
      "expiresAt": 1775000000,
      "userAgent": "Mozilla/5.0 ...",
      "ipAddress": "1.2.3.4",
      "current": true
    }
  ]
}
```

`current: true` marks the session that issued this request.

### DELETE /auth/sessions/:id

Revokes the session with the given ID. Returns `400` if you try to revoke the current session — use `POST /auth/logout` instead.

```json
{ "revoked": true }
```

### POST /auth/sessions/revoke-others

Revokes every session belonging to the user except the current one (sign out all other devices).

```json
{ "revokedCount": 3 }
```

## Client SDK

```ts
// List sessions
const { sessions } = await client.auth.sessions.list();

// Revoke a specific session
await client.auth.sessions.revoke(sessionId);

// Sign out all other devices
const { revokedCount } = await client.auth.sessions.revokeOthers();
```

## Session metadata

Sessions capture `userAgent` and `ipAddress` at creation time. This data is populated automatically by BunBase on login, registration, magic-link/OTP verify, and passkey login — no additional configuration needed.
