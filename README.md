# bunbase

**bunbase** is a TypeScript-native Backend-as-a-Service built on [Bun](https://bun.sh). Point it at a [Drizzle ORM](https://orm.drizzle.team) schema and it generates a full REST API, auth, file storage, realtime WebSockets, and an admin UI — with zero configuration.

## Quick start

```ts
// server.ts
import { createServer, defineRules, defineConfig } from "bunbase";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  title: text("title").notNull(),
  done: text("done").notNull().default("false"),
});

const rules = defineRules({
  tasks: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => auth !== null,
    update: ({ auth }) => auth !== null,
    delete: ({ auth }) => auth?.role === "admin",
  },
});

createServer({ schema: { tasks }, rules }).listen(3000);
```

```sh
bun server.ts
# REST API at http://localhost:3000/api/tasks
# Admin UI  at http://localhost:3000/_admin
```

## New project

```sh
bunx bunbase init my-app
cd my-app
bun install
bun dev
```

`bunbase init` walks you through an interactive setup (schema, auth, OAuth providers) and scaffolds a ready-to-run project. Pass `-y` to accept all defaults non-interactively.

## Installation (existing project)

```sh
bun add bunbase
```

## Core concepts

| Concept | Description |
|---|---|
| **Schema** | Standard Drizzle tables — bunbase generates REST endpoints for each one |
| **Rules** | Per-table, per-operation functions that return `true` / `false` / `SQL` — deny-by-default |
| **Client** | `createBunBaseClient({ url, schema })` — typed proxy for all CRUD, auth, files, and realtime |
| **Realtime** | `config: { realtime: { enabled: true } }` — WebSocket subscriptions via `client.realtime.subscribe(table, cb)` |
| **Storage** | File upload/download per record, local or S3 |
| **Admin UI** | Built-in management UI at `/_admin` |

## Running the example

The [`examples/task-manager`](./examples/task-manager) directory is a full running app demonstrating:
- Server-side filters + cursor pagination
- `expand: ["assignee"]` relational queries
- API key creation and management
- Realtime live task feed

```sh
bun install
bun run --cwd examples/task-manager dev
```

## Patterns reference

See [`docs/examples.ts`](./docs/examples.ts) for compile-checked code snippets covering every pattern: filters, pagination, expand, rules, hooks, jobs, OAuth, and more.

## Fetching all records with `listAll()`

`listAll()` returns every matching record in a single HTTP request — no cursor
loop, no pagination. Internally it passes `limit=-1` to the server, which
queries without a LIMIT clause and returns `hasMore: false`.

```ts
const allTasks = await client.api.tasks.listAll({ filter: { done: false } });
```

With TanStack Query:

```tsx
const { data = [] } = useQuery(api.tasks.listAll.queryOptions({ sort: "createdAt" }));
```

Filter, sort, and expand params work the same as `list()`. For very large tables
where you want to process records incrementally, use `list()` with manual cursor
handling instead.

## Frontend (SPA) serving

BunBase can serve your React/Vue/Svelte SPA alongside the API in a single process.
Enable it with the `frontend` config option.

> **Static import required.** Bun's HTML bundler processes imports at module
> load time. Dynamic `import()` does not work for HTML files — the import must
> be a static top-level statement.

```ts
// server.ts
import indexHtml from "./frontend/index.html";   // static import — required
import { createServer, defineConfig } from "bunbase";

createServer({
  schema,
  rules,
  config: defineConfig({
    frontend: { html: indexHtml },
  }),
}).listen(3000);
```

With `frontend.html` set, BunBase adds `/*` as a SPA catch-all in `Bun.serve()`.
All API namespaces (`/api/*`, `/auth/*`, `/_admin/api/*`, `/files/*`, `/realtime`)
remain more specific and continue to reach BunBase's handlers — Bun's router is
specificity-based, not order-based.

Run with `bun --hot server.ts` for hot module replacement during development.
Tailwind, TSX, and CSS bundling are handled natively by Bun — no Vite needed.
