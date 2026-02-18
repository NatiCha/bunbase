---
title: Extending
---

Add custom tRPC routes to your TSBase server using the `extend` option.

## Adding custom routes

Create a tRPC router and pass it to `createServer`. Since TSBase uses tRPC under the hood, you build your custom router with `@trpc/server` directly:

```ts
// src/custom-routes.ts
import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "tsbase";
import { z } from "zod/v4";

const t = initTRPC.context<Context>().create();

export const customRouter = t.router({
  hello: t.procedure
    .input(z.object({ name: z.string() }))
    .query(({ input }) => {
      return `Hello, ${input.name}!`;
    }),

  secretData: t.procedure
    .use(({ ctx, next }) => {
      if (!ctx.auth) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      return next({ ctx: { ...ctx, auth: ctx.auth } });
    })
    .query(({ ctx }) => {
      return { userId: ctx.auth.id, secret: "42" };
    }),
});
```

```ts
// src/index.ts
import { createServer } from "tsbase";
import * as schema from "./schema";
import { rules } from "./rules";
import { customRouter } from "./custom-routes";

const tsbase = createServer({
  schema,
  rules,
  extend: customRouter,
});

tsbase.listen();
```

Your custom routes are now available at `/trpc/hello` and `/trpc/secretData`.

## Context

Procedures receive a context object:

```ts
interface Context {
  db: SQLiteBunDatabase; // Drizzle database instance
  auth: AuthUser | null; // Current user (null if not logged in)
  req: Request;          // Original HTTP request
}
```

## Accessing the database

Use `ctx.db` (the Drizzle instance) to run queries in your procedures:

```ts
import { eq } from "drizzle-orm";
import { posts } from "./schema";

// Inside a procedure:
.query(({ ctx }) => {
  return ctx.db
    .select()
    .from(posts)
    .where(eq(posts.authorId, ctx.auth!.id))
    .all();
});
```

## Name collisions

Custom route names must not collide with auto-generated CRUD router names (your table names). If a collision is detected, TSBase throws an error at startup:

```
TSBase: Cannot merge extend router due to key collision(s): posts
```

## Calling custom routes from the client

Custom routes are part of the same tRPC router, so they work with the client SDK:

```ts
const greeting = await client.trpc.hello.query({ name: "World" });
const data = await client.trpc.secretData.query();
```

## Next steps

- [Deployment](/deployment/) — go to production
- [Configuration](/configuration/) — full config reference
