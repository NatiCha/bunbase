---
title: Extending
---

Add custom REST routes to your TSBase server using the `extend` option.

## Adding custom routes

Pass a function to `extend` that receives `{ db, extractAuth }` and returns a route map. Each key is a path (must be under `/api/`) and the value is an object mapping HTTP methods to handlers.

```ts
// src/custom-routes.ts
import type { ExtendContext, RouteMap } from "tsbase";
import { requireAuth } from "tsbase";

export function customRoutes({ db, extractAuth }: ExtendContext): RouteMap {
  return {
    "/api/stats": {
      GET: async (_req) => {
        const stats = await db.select(/* ... */);
        return Response.json(stats);
      },
    },

    "/api/my-tasks": {
      GET: async (req) => {
        const auth = await extractAuth(req);
        if (!auth) {
          return Response.json(
            { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
            { status: 401 },
          );
        }
        const tasks = await db.select(/* ... */).where(/* auth.id */);
        return Response.json(tasks);
      },
    },
  };
}
```

```ts
// src/index.ts
import { createServer } from "tsbase";
import * as schema from "./schema";
import { rules } from "./rules";
import { customRoutes } from "./custom-routes";

const tsbase = createServer({
  schema,
  rules,
  extend: customRoutes,
});

tsbase.listen();
```

Your custom routes are now available at `/api/stats` and `/api/my-tasks`.

## Constraints

- All extend routes **must** be under `/api/`. TSBase throws a startup error for any route outside this prefix. This ensures CSRF protection is automatically applied to all mutation methods (`POST`, `PATCH`, `DELETE`).
- Path collisions with generated CRUD routes throw a startup error.

## Context

The `extend` function receives:

```ts
interface ExtendContext {
  db: AnyDb;                                         // Drizzle database instance
  extractAuth: (req: Request) => Promise<AuthUser | null>; // Current user resolver
}
```

## Accessing the database

Use `db` (the Drizzle instance) to run queries in your handlers:

```ts
import { eq } from "drizzle-orm";
import { posts } from "./schema";

GET: async (req) => {
  const auth = await extractAuth(req);
  const myPosts = db
    .select()
    .from(posts)
    .where(eq(posts.authorId, auth!.id))
    .all();
  return Response.json(myPosts);
},
```

## Name collisions

Custom route paths must not collide with auto-generated CRUD routes. If a collision is detected, TSBase throws at startup:

```
TSBase: Cannot merge extend routes due to path collision: /api/posts
```

## Calling custom routes from the client

Use `fetch` directly, or wrap them in your own typed client helpers:

```ts
const res = await fetch("/api/stats", { credentials: "include" });
const stats = await res.json();
```

For mutations, include the CSRF token:

```ts
const csrfToken = document.cookie.match(/csrf_token=([^;]+)/)?.[1] ?? "";
const res = await fetch("/api/my-tasks", {
  method: "POST",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  },
  body: JSON.stringify({ title: "New Task" }),
});
```

## Next steps

- [Deployment](/deployment/) — go to production
- [Configuration](/configuration/) — full config reference
