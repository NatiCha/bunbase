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
| `GET /api/posts` | List posts (with filtering & pagination) |
| `GET /api/posts/:id` | Get a single post |
| `POST /api/posts` | Create a post |
| `PATCH /api/posts/:id` | Update a post |
| `DELETE /api/posts/:id` | Delete a post |
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
curl -X POST 'http://localhost:3000/api/posts' \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -H "X-CSRF-Token: $(grep csrf_token cookies.txt | awk '{print $NF}')" \
  -d '{"title": "Hello World", "body": "My first post", "authorId": "USER_ID"}'
```

List posts:

```bash
curl 'http://localhost:3000/api/posts'
```

## Next steps

- [Schema](/schema/) — learn how to define tables
- [Rules](/rules/) — lock down who can access what
- [Client SDK](/client/) — connect from a frontend app
