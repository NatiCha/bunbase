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
