---
title: TSBase
---

A TypeScript-native backend-as-a-service built on Bun and Drizzle ORM. Define your schema, set access rules, and get a full REST API — auth, CRUD, and file storage — with zero boilerplate.

## Features

- **Auto-generated CRUD API** — list, get, create, update, delete for every table
- **Built-in auth** — email/password registration, login, sessions, OAuth (Google, GitHub, Discord)
- **Access rules** — per-table, per-operation control with SQL WHERE clause injection
- **Lifecycle hooks** — run code before or after any CRUD operation; modify data or abort with an error
- **Scheduled jobs** — background tasks on a cron schedule, wall-clock aligned
- **File storage** — upload/download/delete with local or S3 drivers
- **Type-safe client SDK** — schema-derived frontend client with auth and file helpers
- **Cursor pagination** — efficient, sort-aware pagination out of the box
- **Filtering** — rich query operators (eq, gt, contains, in, isNull, etc.)
- **CSRF protection** — automatic double-submit cookie pattern
- **Rate limiting** — built-in for auth endpoints
- **Admin UI** — browse data at `/_admin` (development mode)

## Documentation

1. [Quickstart](/quickstart/) — get a server running in under 5 minutes
2. [Schema](/schema/) — define tables with Drizzle ORM
3. [Rules](/rules/) — control access per table and operation
4. [CRUD API](/api/crud/) — auto-generated endpoints: filtering, pagination, sorting
5. [Client SDK](/client/) — connect from your frontend
6. [Auth API](/api/auth/) — registration, login, OAuth, password reset
7. [Files API](/api/files/) — upload, download, and delete files
8. [Hooks](/hooks/) — lifecycle callbacks for CRUD operations
9. [Jobs](/jobs/) — scheduled background tasks
10. [Configuration](/configuration/) — full `defineConfig` reference
11. [Extending](/extending/) — add custom REST routes
12. [Deployment](/deployment/) — production checklist

## Quick example

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
  body: text("body"),
  authorId: text("author_id").notNull(),
});
```

```ts
// src/index.ts
import { createServer, defineConfig } from "tsbase";
import * as schema from "./schema";
import { rules } from "./rules";
import { hooks } from "./hooks"; // optional
import { jobs } from "./jobs";   // optional

const tsbase = createServer({ schema, rules, hooks, jobs });
tsbase.listen(); // http://localhost:3000
```

That's it. You now have a full REST API with auth, CRUD, file storage, lifecycle hooks, and scheduled jobs.
