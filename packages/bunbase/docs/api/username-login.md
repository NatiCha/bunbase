# Username Login

Allow users to log in with a username instead of (or in addition to) their email address.

## Configuration

```ts
createServer({
  config: defineConfig({
    auth: {
      usernameLogin: {
        enabled: true,        // default: false
        field: "username",    // column name in users table, default: "username"
      },
    },
  }),
});
```

Your users table must have the configured column:

```ts
const users = sqliteTable("users", {
  id:           text("id").primaryKey(),
  email:        text("email").notNull(),
  username:     text("username").notNull().unique(),
  passwordHash: text("password_hash"),
  role:         text("role").notNull().default("user"),
});
```

## Login

Once enabled, `/auth/login` accepts three identifier forms:

| Field | Behavior |
|---|---|
| `email` | Looks up by email (unchanged) |
| `username` | Looks up by the configured field |
| `identifier` | If it contains `@`, treated as email; otherwise as username |

```ts
// Email login (always works)
await client.auth.login({ email: "alice@example.com", password: "secret" });

// Username login (requires usernameLogin.enabled)
await client.auth.login({ username: "alice", password: "secret" });

// Identifier — auto-detects based on "@"
await client.auth.login({ identifier: "alice", password: "secret" });
await client.auth.login({ identifier: "alice@example.com", password: "secret" });
```

## Notes

- Username lookup is case-sensitive (unlike email lookup which is case-insensitive).
- Registration still requires `email` and `password`. Usernames are set as extra fields.
- If `usernameLogin.enabled` is `false` and a request provides `username` or a non-email `identifier`, the server returns `400 BAD_REQUEST`.
