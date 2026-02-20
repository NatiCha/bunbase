---
title: Schema
---

TSBase uses [Drizzle ORM](https://orm.drizzle.team) to define your database schema. You write standard Drizzle table definitions, and TSBase generates CRUD endpoints for each table automatically.

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

Every table **must** have an `id` column with type `text` as its primary key. TSBase generates UUIDv7 IDs automatically on create if none is provided.

## The users table

The `users` table is special. TSBase uses it for authentication. It requires these columns:

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

## Automatic timestamps

TSBase automatically adds `created_at` and `updated_at` columns to every user-defined table. You don't need to declare them in your schema — they are injected at startup and managed automatically.

## Migrations

TSBase uses Drizzle Kit for migrations. After changing your schema:

```bash
# Generate a migration
bunx drizzle-kit generate

# Migrations run automatically on server start
bun dev
```

TSBase reads migrations from the `./drizzle` directory by default (configurable via `migrationsPath` in your config).

The `drizzle.config.ts` file created by `tsbase init`:

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
import { createServer } from "tsbase";
import * as schema from "./schema";

const tsbase = createServer({ schema });
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
import { defineRelations } from "tsbase";
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
import { createServer } from "tsbase";
import * as schema from "./schema";
import { relations } from "./relations";

const tsbase = createServer({
  schema,
  relations, // enables ?expand= on CRUD endpoints
});

tsbase.listen();
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
