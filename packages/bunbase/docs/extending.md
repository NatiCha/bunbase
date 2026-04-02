---
title: Extending
---

Add custom REST routes to your BunBase server using the `extend` option.

## Adding custom routes

Pass a function to `extend` that receives `{ db, extractAuth }` and returns a route map. Each key is a path (must be under `/api/`) and the value is an object mapping HTTP methods to handlers.

```ts
// src/custom-routes.ts
import type { ExtendContext, RouteMap } from "bunbase";
import { requireAuth } from "bunbase";

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
import { createServer } from "bunbase";
import * as schema from "./schema";
import { rules } from "./rules";
import { customRoutes } from "./custom-routes";

const bunbase = createServer({
  schema,
  rules,
  extend: customRoutes,
});

bunbase.listen();
```

Your custom routes are now available at `/api/stats` and `/api/my-tasks`.

## Constraints

- By default, HTTP extend routes **must** be under `/api/`. This ensures CSRF protection is automatically applied to all mutation methods (`POST`, `PATCH`, `DELETE`).
- Use `unscoped: true` to opt out of the `/api/` prefix requirement (see [Unscoped routes](#unscoped-routes) below).
- WebSocket routes are exempt from the `/api/` prefix requirement (WebSocket connections require explicit `new WebSocket()` calls and are not CSRF-vulnerable).
- Path collisions with generated CRUD routes throw a startup error.
- WebSocket routes cannot override the built-in `/realtime` endpoint.

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

Custom route paths must not collide with auto-generated CRUD routes. If a collision is detected, BunBase throws at startup:

```
BunBase: Cannot merge extend routes due to path collision: /api/posts
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

## Unscoped routes

Routes outside `/api/` are useful for OAuth endpoints, well-known URIs, file downloads, and other externally-consumed paths. Set `unscoped: true` to opt out of the `/api/` prefix requirement:

```ts
extend: (ctx) => ({
  // Normal route — under /api/, CSRF protected
  "/api/v1/health": { GET: () => Response.json({ status: "ok" }) },

  // Unscoped — outside /api/, no CSRF
  "/.well-known/oauth-authorization-server": {
    unscoped: true,
    GET: () => Response.json({ issuer: "https://auth.example.com" }),
  },

  "/token": {
    unscoped: true,
    POST: async (req) => {
      // OAuth token endpoint — no CSRF needed
      const body = await req.json();
      return Response.json({ access_token: "..." });
    },
  },

  "/install.sh": {
    unscoped: true,
    GET: () => new Response("#!/bin/sh\ncurl ...", {
      headers: { "Content-Type": "text/plain" },
    }),
  },
})
```

**Key behavior:**

- CSRF is **not** applied to unscoped routes (CSRF only covers `/api/` and `/_admin/api/` paths).
- Unscoped routes cannot collide with reserved paths: `/health`, `/_admin*`, `/auth/*`, `/realtime`, `/files/*`.
- CORS headers are still applied to unscoped routes.

## WebSocket routes

Add WebSocket endpoints to `extend` using the `websocket` property on a route definition. Use `defineWebSocket` for full TypeScript inference of `ws.data`.

```ts
import { createServer, defineWebSocket } from "bunbase";

const bunbase = createServer({
  schema,
  rules,
  extend: (ctx) => ({
    "/bridge": {
      websocket: defineWebSocket({
        // Optional: return data to attach to ws.data, or a Response to reject
        async upgrade(req) {
          const auth = await ctx.extractAuth(req);
          if (!auth) return new Response("Unauthorized", { status: 401 });
          return { userId: auth.id, deviceId: new URL(req.url).searchParams.get("device") };
        },
        open(ws) {
          console.log(`Connected: ${ws.data.userId}`); // typed from upgrade()
        },
        message(ws, message) {
          ws.send(`echo: ${message}`);
        },
        close(ws, code, reason) {
          console.log(`Disconnected: ${ws.data.userId}`);
        },
      }),
    },
  }),
});
```

### Handlers

| Handler | Required | Description |
|---------|----------|-------------|
| `upgrade(req)` | No | Called on HTTP upgrade request. Return data for `ws.data`, or a `Response` to reject the connection. Defaults to `{}`. |
| `open(ws)` | No | Called when the WebSocket connection is established. |
| `message(ws, message)` | Yes | Called when a message is received. |
| `close(ws, code, reason)` | No | Called when the connection closes. |
| `error(ws, error)` | No | Called on WebSocket error. |

### Per-path configuration

Each WebSocket route can set `idleTimeout` (seconds, default 120) and `maxPayloadLength` (bytes, default 16 MB). Since Bun only allows one global config, BunBase uses the most permissive values across all routes.

```ts
websocket: defineWebSocket({
  message(ws, msg) { /* ... */ },
  idleTimeout: 300,
  maxPayloadLength: 64 * 1024 * 1024, // 64 MB
}),
```

### Mixed HTTP + WebSocket

A single path can have both HTTP method handlers and a `websocket` definition:

```ts
"/api/bridge": {
  GET: (req) => Response.json({ status: "ok" }),
  websocket: defineWebSocket({
    message(ws, msg) { ws.send(msg); },
  }),
},
```

Regular HTTP requests are handled normally; only requests with the `Upgrade: websocket` header trigger the WebSocket upgrade.

### Coexistence with realtime

Extend WebSocket routes work alongside BunBase's built-in `/realtime` endpoint. Both share Bun's single `websocket` handler object — BunBase dispatches to the correct handler automatically.

### Connecting from the client

```ts
const ws = new WebSocket("ws://localhost:3000/bridge?device=abc");
ws.onmessage = (e) => console.log(e.data);
ws.onopen = () => ws.send("hello");
```

## Next steps

- [Deployment](/deployment/) — go to production
- [Configuration](/configuration/) — full config reference
