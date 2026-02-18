---
title: Quickstart
---

Get a TSBase server running in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh) v1.1+

## Create a project

```bash
bunx tsbase init my-app
cd my-app
bun install
```

This scaffolds:

```
my-app/
├── src/
│   ├── index.ts      # Server entry point
│   ├── schema.ts     # Drizzle table definitions
│   └── rules.ts      # Access control rules
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

## Start the server

```bash
bun dev
```

Your server is now running at `http://localhost:3000`.

## What you get

With zero additional code, you have:

| Endpoint | Description |
|---|---|
| `POST /auth/register` | Create a user account |
| `POST /auth/login` | Log in, get a session cookie |
| `POST /auth/logout` | Log out |
| `GET /auth/me` | Get current user |
| `/trpc/posts.list` | List posts (with filtering & pagination) |
| `/trpc/posts.get` | Get a single post |
| `/trpc/posts.create` | Create a post |
| `/trpc/posts.update` | Update a post |
| `/trpc/posts.delete` | Delete a post |
| `GET /health` | Health check |

## Try it out

Register a user:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "secret123"}' \
  -c cookies.txt
```

Create a post (using the session cookie):

```bash
curl -X POST 'http://localhost:3000/trpc/posts.create' \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -H "X-CSRF-Token: $(grep csrf_token cookies.txt | awk '{print $NF}')" \
  -d '{"title": "Hello World", "body": "My first post", "authorId": "USER_ID"}'
```

List posts:

```bash
curl 'http://localhost:3000/trpc/posts.list'
```

## Next steps

- [Schema](/schema/) — learn how to define tables
- [Rules](/rules/) — lock down who can access what
- [Client SDK](/client/) — connect from a frontend app
