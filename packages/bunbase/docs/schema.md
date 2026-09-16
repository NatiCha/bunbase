---
title: Schema
---

BunBase uses [Drizzle ORM](https://orm.drizzle.team) to define your database schema. You write standard Drizzle table definitions, and BunBase generates CRUD endpoints for each table automatically.

## Defining tables

Tables are defined using `sqliteTable` from `drizzle-orm/sqlite-core`:

```ts
// src/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  name: text("name"),
});

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body"),
  authorId: text("author_id").notNull(),
  published: integer("published").default(0),
});
```

Every table **must** have an `id` column as its primary key. If the `id` column
is a `text` column **without** its own default, BunBase generates a UUIDv7 on
create when the client doesn't supply one. If you prefer, declare the default on
the column yourself:

```ts
id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
```

`id` is **immutable** by default — it can be set on create but is ignored on
update (a client cannot re-key a row via `PATCH`). See [Field policy](#field-policy).

## The users table

The `users` table is special. BunBase uses it for authentication. It requires these columns:

| Column | Type | Required |
|---|---|---|
| `id` | `text` primary key | Yes |
| `email` | `text` unique, not null | Yes |
| `passwordHash` | `text("password_hash")` | Yes |
| `role` | `text` default `"user"` | Yes |

You can add any additional columns (e.g. `name`, `avatar`, `bio`). Extra columns that are `notNull` without a default will be required during registration.

```ts
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  // Additional fields — "name" becomes required during signup
  name: text("name").notNull(),
  bio: text("bio"), // optional, not required during signup
});
```

## Timestamps

BunBase does **not** inject timestamp columns for you — declare them on the
tables that need them and let Drizzle manage their values:

```ts
createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
updatedAt: text("updated_at")
  .notNull()
  .$defaultFn(() => new Date().toISOString())
  .$onUpdateFn(() => new Date().toISOString()),
```

`createdAt`/`created_at` and `updatedAt`/`updated_at` are **immutable** by
default — settable on create, ignored on update — so a client cannot backdate a
row. See [Field policy](#field-policy).

## Field policy

By default, BunBase protects sensitive and server-controlled columns at the CRUD
boundary:

- **`passwordHash` / `password_hash`** are always hidden from responses (and from
  pagination cursors and realtime broadcasts) and can never be written via CRUD.
- **`id` and timestamp columns** are immutable on update (settable on create).
- Everything else is readable and writable subject to your [rules](./rules.md).

To hide additional columns or block writes to privileged columns, pass a `fields`
policy to `createServer` (mirrors `rules`/`hooks`):

```ts
import { createServer, defineFields } from "@naticha/bunbase";
import * as schema from "./schema";

createServer({
  schema,
  rules,
  fields: {
    users: defineFields(schema.users, {
      hidden: ["mfaSecret"],            // never serialized; not filterable/sortable
      readonly: ["role", "emailVerified"], // never settable via CRUD (set by hooks/admin/auth)
    }),
  },
});
```

A `hidden` column is stripped from every response, cannot be used in `filter` or
`sort`, and cannot be written. A `readonly` column is never written by CRUD
create or update — set it from a [hook](./hooks.md), the admin API, or an auth
flow instead. Without this, any column a client can reach through an `update`
rule can be mass-assigned (e.g. `role: "admin"`), so mark privileged columns
`readonly`.

## Migrations

BunBase uses Drizzle Kit for migrations. After changing your schema:

```bash
# Generate a migration
bunx drizzle-kit generate

# Migrations run automatically on server start
bun dev
```

BunBase reads migrations from the `./drizzle` directory by default (configurable via `migrationsPath` in your config).

The `drizzle.config.ts` file created by `bunbase init`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  dbCredentials: {
    url: "./data/db.sqlite",
  },
});
```

## Passing schema to the server

Export all tables from your schema file and pass them to `createServer`:

```ts
import { createServer } from "@naticha/bunbase";
import * as schema from "./schema";

const bunbase = createServer({ schema });
```

Every exported Drizzle table (except those with names starting with `_`) gets a CRUD router generated automatically.

## Relations (for `?expand=`)

To support the `?expand=relation` query parameter on CRUD endpoints, define relations using `defineRelations` and pass them as a separate `relations` option:

```ts
// src/schema.ts
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  name: text("name"),
});

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id"),
});
```

```ts
// src/relations.ts
import { defineRelations } from "@naticha/bunbase";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  posts: {
    author: r.one.users({
      from: r.posts.authorId,
      to: r.users.id,
    }),
  },
}));
```

```ts
// src/index.ts
import { createServer } from "@naticha/bunbase";
import * as schema from "./schema";
import { relations } from "./relations";

const bunbase = createServer({
  schema,
  relations, // enables ?expand= on CRUD endpoints
});

bunbase.listen();
```

With this in place, clients can request related data inline:

```
GET /api/posts?expand=author
GET /api/posts/post-id?expand=author
```

The `defineRelations` callback receives a relation builder `r` where `r.one` and `r.many` define to-one and to-many associations between tables.

## Next steps

- [Rules](/rules/) — control who can access each table
- [CRUD API](/api/crud/) — how the auto-generated endpoints work
