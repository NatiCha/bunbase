# Task Manager — TSBase Example

A full-stack task management app built on TSBase. Demonstrates auth, CRUD, access rules, and the admin UI.

## Stack

- **Backend** — TSBase (Bun + Drizzle ORM + tRPC)
- **Frontend** — React 19 + Tailwind CSS v4
- **Database** — SQLite (local file at `./data/db.sqlite`)

## Prerequisites

- [Bun](https://bun.sh) v1.1+

## Getting started

### 1. Install dependencies

From the **monorepo root**:

```sh
bun install
```

### 2. Generate & apply database migrations

```sh
cd examples/task-manager
bun run db:generate   # generates SQL from schema.ts → drizzle/
```

The migrations are applied automatically on server start.

### 3. Start the dev server

```sh
bun run dev
```

This starts both the TSBase API server and the frontend bundler concurrently.

| Service | URL |
|---------|-----|
| App | http://localhost:3000 |
| Admin UI | http://localhost:3000/_admin |

### 4. Create your first user

```sh
curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password123","name":"Admin"}' | jq .
```

### 5. Promote the user to admin

```sh
bun -e "
  import { Database } from 'bun:sqlite';
  const db = new Database('./data/db.sqlite');
  db.run(\"UPDATE users SET role = 'admin' WHERE email = 'admin@example.com'\");
  console.log('Done — user is now admin');
"
```

### 6. Open the admin UI

Navigate to http://localhost:3000/_admin and sign in with your credentials.

## Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start API + frontend in watch mode |
| `bun run dev:server` | API server only (port 3000) |
| `bun run dev:client` | Frontend bundler only |
| `bun run start` | Production mode |
| `bun run db:generate` | Generate Drizzle migrations from schema |
| `bun run db:studio` | Open Drizzle Studio (data browser) |

## Schema

```
users      — id, email, password_hash, role, name, avatar_url
projects   — id, name, description, owner_id
tasks      — id, title, description, status, priority, project_id, assignee_id
```

## Access rules

| Resource | list | get | create | update | delete |
|----------|------|-----|--------|--------|--------|
| projects | ✓ public | ✓ public | authenticated | owner only | owner only |
| tasks | ✓ public | ✓ public | authenticated | authenticated | admin only |

## Resetting the database

```sh
rm -rf ./data
bun run dev   # migrations re-apply on next start
```
