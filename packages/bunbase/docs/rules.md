---
title: Rules
---

Rules control who can access what. You define per-table, per-operation rules that run before every CRUD request.

## Defining rules

Use `defineRules` to declare access control:

```ts
// src/rules.ts
import { defineRules, authenticated } from "bunbase";

export const rules = defineRules({
  posts: {
    list: () => true,            // anyone can list
    get: () => true,             // anyone can read
    create: ({ auth }) => authenticated(auth), // logged-in users only
    update: ({ auth }) => authenticated(auth),
    delete: ({ auth }) => auth?.role === "admin", // admins only
  },
});
```

Pass rules to `createServer`:

```ts
const bunbase = createServer({ schema, rules });
```

## Operations

Each table supports these operations:

| Operation | Applies to |
|---|---|
| `list` | Listing/querying records |
| `get` (or `view`) | Reading a single record by ID |
| `create` | Creating a new record |
| `update` | Updating an existing record |
| `delete` | Deleting a record |

If no rule is defined for an operation, it defaults to **deny** (403 Forbidden). BunBase logs a warning at startup for any operation that has no rule defined, so gaps are easy to spot before deploying. To explicitly allow public access to a table, use the `allowAll` helper.

## Rule argument

Every rule function receives a `RuleArg` with everything needed to make an access decision:

```ts
type RuleArg = {
  auth: AuthUser | null;                  // null if not logged in
  id?: string;                            // record ID (get/update/delete)
  record?: Record<string, unknown>;       // existing record (update/delete)
  body: Record<string, unknown>;          // request body (create/update), {} otherwise
  headers: Record<string, string>;        // lowercased header keys
  query: Record<string, string>;          // URL search params
  method: string;                         // GET, POST, PATCH, DELETE, SUBSCRIBE
  db: AnyDb;                              // for cross-table queries
};

type AuthUser = {
  id: string;
  email: string;
  role: string;
  [key: string]: unknown; // any extra user columns
};
```

## Return types

A rule function can return three types of values:

| Return | Effect |
|---|---|
| `true` or `null` | Allow the operation |
| `false` | Deny the operation (403 Forbidden) |
| `SQL` (Drizzle WHERE clause) | Allow, but filter results to matching rows |

The SQL return type is powerful — it lets you scope queries to only the rows a user should see, without a separate database lookup.

## Built-in helpers

BunBase exports common rule patterns:

### `authenticated`

Allow only logged-in users:

```ts
import { authenticated } from "bunbase";

const rules = defineRules({
  posts: {
    create: ({ auth }) => authenticated(auth),
  },
});
```

### `admin`

Allow only users with `role === "admin"`:

```ts
import { admin } from "bunbase";

const rules = defineRules({
  posts: {
    delete: ({ auth }) => admin(auth),
  },
});
```

### `ownerOnly`

Allow only the record owner. Returns a SQL WHERE clause that filters to rows where the specified column matches the authenticated user's ID:

```ts
import { ownerOnly } from "bunbase";
import { posts } from "./schema";

const rules = defineRules({
  posts: {
    update: ({ auth }) => ownerOnly(posts.authorId, auth),
    delete: ({ auth }) => ownerOnly(posts.authorId, auth),
  },
});
```

When used on `list`, this filters results to only the user's own records. When used on `update`/`delete`, it checks that the record belongs to the user before allowing the operation.

### `adminOrOwner`

Allow admins full access, or scope to the record owner:

```ts
import { adminOrOwner } from "bunbase";
import { posts } from "./schema";

const rules = defineRules({
  posts: {
    update: ({ auth }) => adminOrOwner(posts.authorId, auth),
    delete: ({ auth }) => adminOrOwner(posts.authorId, auth),
  },
});
```

### `isSet`

Check if a field was submitted in the request body. Useful to prevent clients from setting protected fields:

```ts
import { isSet } from "bunbase";

const rules = defineRules({
  posts: {
    create: ({ auth, body }) => {
      if (isSet(body, "role")) return false; // prevent role escalation
      return !!auth;
    },
  },
});
```

### `isChanged`

Check if a field was submitted AND differs from the existing record value. Returns `false` if the field is not in the body. Returns `true` if there is no existing record to compare against.

```ts
import { isChanged } from "bunbase";

const rules = defineRules({
  posts: {
    update: ({ auth, body, record }) => {
      if (isChanged(body, record, "authorId")) return false; // can't reassign ownership
      return !!auth;
    },
  },
});
```

### `fieldLength`

Return the length of an array field on an existing record. Returns 0 if the record is missing or the field is not an array.

```ts
import { fieldLength } from "bunbase";

const rules = defineRules({
  posts: {
    update: ({ body, record }) => {
      if (fieldLength(record, "tags") >= 10) return false; // max 10 tags
      return true;
    },
  },
});
```

### `collection`

Cross-table query helper for use in rules. Lets you check a related table before granting access:

```ts
import { collection } from "bunbase";
import { memberships } from "./schema";
import { eq } from "drizzle-orm";

const rules = defineRules({
  projects: {
    list: async ({ auth, db }) => {
      if (!auth) return false;
      const rows = await collection(db, memberships, eq(memberships.userId, auth.id));
      return rows.length > 0;
    },
  },
});
```

### Date helpers

Convenient `Date` values for time-based rules:

```ts
import { now, todayStart, todayEnd, monthStart, yearStart } from "bunbase";

// Allow creating records only during business hours
const rules = defineRules({
  orders: {
    create: () => {
      const hour = now().getHours();
      return hour >= 9 && hour < 17;
    },
  },
});
```

| Helper | Returns |
|---|---|
| `now()` | Current `Date` |
| `todayStart()` | Today at 00:00:00.000 |
| `todayEnd()` | Today at 23:59:59.999 |
| `monthStart()` | First day of this month at 00:00:00.000 |
| `yearStart()` | January 1 of this year at 00:00:00.000 |

## Custom rules

Write any logic you need. Rules can be async:

```ts
const rules = defineRules({
  posts: {
    create: ({ auth, body }) => {
      if (!auth) return false;
      if (isSet(body, "role")) return false; // prevent role field injection
      // Only verified users can create posts
      return auth.emailVerified === 1;
    },
    update: ({ auth, body, record }) => {
      // Can't reassign the author
      if (isChanged(body, record, "authorId")) return false;
      return ownerOnly(posts.authorId, auth);
    },
  },
});
```

## Next steps

- [Hooks](/hooks/) — run code before or after CRUD operations (rules run first, then hooks)
- [CRUD API](/api/crud/) — see how rules interact with the generated endpoints
- [Configuration](/configuration/) — configure auth, storage, and more
