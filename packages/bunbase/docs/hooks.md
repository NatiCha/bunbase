---
title: Hooks
---

Hooks run custom code before or after CRUD operations and auth events — modify data on the way in, trigger side effects on the way out, or abort an operation by throwing an error.

## Defining hooks

`defineHooks` has two overloads.

### Typed overload (preferred)

Pass the Drizzle table as the first argument to get full type inference on `data` and `record`:

```ts
// src/hooks.ts
import { defineHooks, ApiError } from "bunbase";
import { tasks } from "./schema";

export const hooks = {
  tasks: defineHooks(tasks, {
    beforeCreate: async ({ data, auth }) => {
      // `data` is typed as TaskInsert — autocomplete works
      return { ...data, ownerId: auth?.id };
    },

    afterCreate: async ({ record }) => {
      // `record` is typed as Task
      await sendSlackNotification(`New task: ${record.title}`);
    },

    beforeDelete: ({ record }) => {
      if (record.priority === "critical") {
        throw new ApiError("FORBIDDEN", "Cannot delete critical tasks", 403);
      }
    },
  }),
};
```

### Multi-table untyped overload

Pass a record of table name → hooks object. Types fall back to `Record<string, unknown>`:

```ts
export const hooks = defineHooks({
  tasks: {
    beforeCreate: async ({ data, auth }) => ({ ...data, ownerId: auth?.id }),
    afterCreate: async ({ record }) => { /* record: Record<string, unknown> */ },
  },
});
```

Pass hooks to `createServer`:

```ts
const bunbase = createServer({ schema, rules, hooks });
```

## Hook types

Each table supports six optional hooks:

| Hook | Runs | Can modify data |
|---|---|---|
| `beforeCreate` | Before a record is inserted | Yes — return new data object |
| `afterCreate` | After a record is inserted | No |
| `beforeUpdate` | Before a record is updated | Yes — return new data object |
| `afterUpdate` | After a record is updated | No |
| `beforeDelete` | Before a record is deleted | No |
| `afterDelete` | After a record is deleted | No |

Rules run first. If a rule denies a request, hooks are never called.

## Hook context

Each hook receives a context object with the relevant information for that operation. All contexts include a `request` field with the originating HTTP request details.

```ts
type HookRequest = {
  method: string;
  path: string;
  ip: string | null; // client IP (respects X-Forwarded-For when trustedProxies is set)
  headers: Headers;
};
```

### `beforeCreate`

```ts
type BeforeCreateContext = {
  data: Record<string, unknown>; // incoming fields (after column mapping)
  auth: AuthUser | null;         // current user
  tableName: string;
  request: HookRequest;
};
```

Return a new data object to replace the insert payload, or return nothing to pass it through unchanged:

```ts
beforeCreate: ({ data, auth, request }) => {
  return { ...data, createdBy: auth?.id };
},
```

### `afterCreate`

```ts
type AfterCreateContext = {
  record: Record<string, unknown>; // the newly created row
  auth: AuthUser | null;
  tableName: string;
  request: HookRequest;
};
```

### `beforeUpdate`

```ts
type BeforeUpdateContext = {
  id: string;
  data: Record<string, unknown>;     // incoming fields
  existing: Record<string, unknown>; // current row (pre-update)
  auth: AuthUser | null;
  tableName: string;
  request: HookRequest;
};
```

`beforeUpdate` only runs if the record exists. A missing record returns 404 without calling the hook.

Return a new data object to replace the update payload, or return nothing to pass it through unchanged:

```ts
beforeUpdate: ({ data, existing, request }) => {
  // Prevent downgrading a priority
  if (existing.priority === "high" && data.priority === "low") {
    return { ...data, priority: "high" };
  }
},
```

### `afterUpdate`

```ts
type AfterUpdateContext = {
  id: string;
  record: Record<string, unknown>; // the updated row
  auth: AuthUser | null;
  tableName: string;
  request: HookRequest;
};
```

### `beforeDelete`

```ts
type BeforeDeleteContext = {
  id: string;
  record: Record<string, unknown>; // the row about to be deleted
  auth: AuthUser | null;
  tableName: string;
  request: HookRequest;
};
```

### `afterDelete`

```ts
type AfterDeleteContext = {
  id: string;
  record: Record<string, unknown>; // the row that was deleted
  auth: AuthUser | null;
  tableName: string;
  request: HookRequest;
};
```

## Aborting operations

Throw an `ApiError` in any `before*` hook to abort the operation and return an error response to the client. The database is not modified.

```ts
import { ApiError } from "bunbase";

beforeDelete: ({ record, auth }) => {
  if (record.ownerId !== auth?.id) {
    throw new ApiError("FORBIDDEN", "You do not own this record", 403);
  }
},
```

Any status code works — `400`, `403`, `409`, `422`, etc. The `code` and `message` are forwarded directly to the client:

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not own this record" } }
```

If a `before*` hook throws anything other than an `ApiError`, the operation is aborted and the client receives a `500` response with code `HOOK_ERROR`. The original error is logged server-side.

## After-hook errors

Errors thrown in `after*` hooks are **caught and logged** — they never affect the HTTP response. A failed `afterCreate` still returns a `201`. Use `after*` hooks for side effects where partial failure is acceptable (notifications, audit logs, cache invalidation).

## Async hooks

All hooks support `async`/`await`:

```ts
beforeCreate: async ({ data }) => {
  const slug = await generateUniqueSlug(data.title as string);
  return { ...data, slug };
},
```

## Multiple tables

Define hooks for as many tables as needed in a single `defineHooks` call:

```ts
export const hooks = defineHooks({
  posts: {
    beforeCreate: ({ data, auth }) => ({ ...data, authorId: auth?.id }),
  },
  comments: {
    afterCreate: async ({ record }) => {
      await updateCommentCount(record.postId as string);
    },
    beforeDelete: ({ auth }) => {
      if (!auth) throw new ApiError("UNAUTHORIZED", "Not authenticated", 401);
    },
  },
});
```

Tables with no hooks defined work exactly as before.

## Auth hooks

Use `defineAuthHooks` to hook into auth events — registration, login, OAuth, and email flows. Auth hooks are separate from CRUD hooks and are registered on the `authHooks` option.

```ts
// src/auth-hooks.ts
import { defineAuthHooks, ApiError } from "bunbase";

export const authHooks = defineAuthHooks({
  beforeRegister: async ({ email, data }) => {
    // Restrict signups to a specific domain
    if (!email.endsWith("@company.com")) {
      throw new ApiError("FORBIDDEN", "Registration is invite-only", 403);
    }
    // Modify the insert data (return a new object)
    return { ...data, tier: "free" };
  },

  afterRegister: async ({ user }) => {
    await sendWelcomeEmail(user.email as string);
  },

  afterLogin: async ({ user }) => {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id as string));
  },

  afterOAuthLogin: async ({ user, provider, isNewUser }) => {
    if (isNewUser) {
      await createOnboardingRecord(user.id as string);
    }
  },

  afterPasswordReset: async ({ userId }) => {
    await sendSecurityAlert(userId);
  },

  afterEmailVerify: async ({ userId }) => {
    await upgradeAccountAccess(userId);
  },
});
```

Pass auth hooks to `createServer`:

```ts
const bunbase = createServer({ schema, rules, hooks, authHooks });
```

### Auth hook surface

| Hook | Fires | Can modify | Can abort |
|---|---|---|---|
| `beforeRegister` | After validation, before DB insert | `data` — return new object | Yes (throw ApiError) |
| `afterRegister` | After user created + session set | No | No (errors logged) |
| `beforeLogin` | After validation, before credential check | No | Yes (throw ApiError) |
| `afterLogin` | After session created | No | No (errors logged) |
| `beforeOAuthLogin` | After provider returns user info, before DB resolution | No | Yes (throw ApiError) |
| `afterOAuthLogin` | After user resolved/created + session set | No | No (errors logged) |
| `beforePasswordReset` | After valid token confirmed, before password update | No | Yes (throw ApiError) |
| `afterPasswordReset` | After password changed + sessions wiped | No | No (errors logged) |
| `afterEmailVerify` | After email marked verified | No | No (errors logged) |

### Auth hook context types

```ts
type BeforeRegisterContext = {
  email: string;
  data: Record<string, unknown>; // insert payload (excluding passwordHash)
  req: Request;
};

type AfterRegisterContext = {
  user: Record<string, unknown>; // created user (passwordHash stripped)
  userId: string;
};

type BeforeLoginContext = {
  email: string;
  req: Request;
};

type AfterLoginContext = {
  user: Record<string, unknown>; // logged-in user (passwordHash stripped)
  userId: string;
};

type BeforeOAuthLoginContext = {
  provider: string;              // "google" | "github" | "discord"
  userInfo: { id: string; email: string; name?: string; avatar?: string };
  req: Request;
};

type AfterOAuthLoginContext = {
  user: Record<string, unknown>;
  userId: string;
  provider: string;
  isNewUser: boolean;            // true if a new user row was created
};

type BeforePasswordResetContext = { userId: string };
type AfterPasswordResetContext  = { userId: string };
type AfterEmailVerifyContext    = { userId: string };
```

### Error handling

Same rules as CRUD hooks:
- **`before*` hooks**: throw `ApiError` to return a specific status. Any other error returns `500` with code `AUTH_HOOK_ERROR`.
- **`after*` hooks**: errors are caught and logged. They never change the response the client receives.

## Next steps

- [Rules](/rules/) — access control that runs before hooks
- [Extending](/extending/) — add custom REST routes
- [Jobs](/jobs/) — run background tasks on a schedule
