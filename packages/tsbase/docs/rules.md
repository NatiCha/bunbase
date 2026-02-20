---
title: Rules
---

Rules control who can access what. You define per-table, per-operation rules that run before every CRUD request.

## Defining rules

Use `defineRules` to declare access control:

```ts
// src/rules.ts
import { defineRules, authenticated } from "tsbase";

export const rules = defineRules({
  posts: {
    list: () => true,            // anyone can list
    get: () => true,             // anyone can read
    create: (ctx) => authenticated(ctx), // logged-in users only
    update: (ctx) => authenticated(ctx),
    delete: (ctx) => ctx.auth?.role === "admin", // admins only
  },
});
```

Pass rules to `createServer`:

```ts
const tsbase = createServer({ schema, rules });
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

If no rule is defined for an operation, it defaults to **allow** (open access).

## Rule context

Every rule function receives a `RuleContext`:

```ts
type RuleContext = {
  auth: AuthUser | null; // null if not logged in
  id?: string;           // record ID (for get/update/delete)
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

TSBase exports common rule patterns:

### `authenticated`

Allow only logged-in users:

```ts
import { authenticated } from "tsbase";

const rules = defineRules({
  posts: {
    create: (ctx) => authenticated(ctx),
  },
});
```

### `admin`

Allow only users with `role === "admin"`:

```ts
import { admin } from "tsbase";

const rules = defineRules({
  posts: {
    delete: (ctx) => admin(ctx),
  },
});
```

### `ownerOnly`

Allow only the record owner. Returns a SQL WHERE clause that filters to rows where the specified column matches the authenticated user's ID:

```ts
import { ownerOnly } from "tsbase";
import { posts } from "./schema";

const rules = defineRules({
  posts: {
    update: (ctx) => ownerOnly(posts.authorId, ctx),
    delete: (ctx) => ownerOnly(posts.authorId, ctx),
  },
});
```

When used on `list`, this filters results to only the user's own records. When used on `update`/`delete`, it checks that the record belongs to the user before allowing the operation.

### `adminOrOwner`

Allow admins full access, or scope to the record owner:

```ts
import { adminOrOwner } from "tsbase";
import { posts } from "./schema";

const rules = defineRules({
  posts: {
    update: (ctx) => adminOrOwner(posts.authorId, ctx),
    delete: (ctx) => adminOrOwner(posts.authorId, ctx),
  },
});
```

## Custom rules

Write any logic you need. Rules can be async:

```ts
const rules = defineRules({
  posts: {
    create: (ctx) => {
      if (!ctx.auth) return false;
      // Only verified users can create posts
      return ctx.auth.emailVerified === 1;
    },
  },
});
```

## Next steps

- [Hooks](/hooks/) — run code before or after CRUD operations (rules run first, then hooks)
- [CRUD API](/api/crud/) — see how rules interact with the generated endpoints
- [Configuration](/configuration/) — configure auth, storage, and more
