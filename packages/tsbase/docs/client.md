---
title: Client SDK
---

TSBase includes a frontend SDK that provides a type-safe REST client alongside auth and file helpers.

## Installation

The client is included in the `tsbase` package:

```ts
import { createTSBaseClient } from "tsbase/client";
```

## Setup

```ts
import { createTSBaseClient } from "tsbase/client";
import type * as schema from "../server/src/schema"; // your Drizzle schema

const client = createTSBaseClient<typeof schema>({
  url: "http://localhost:3000",
});
```

The client has three namespaces: `api`, `auth`, and `files`.

## `api` — CRUD operations

The `api` namespace is typed directly from your Drizzle schema. Every table gets `list`, `get`, `create`, `update`, and `delete` methods.

```ts
// List posts
const { data, nextCursor, hasMore } = await client.api.posts.list({
  filter: { published: 1 },
  limit: 10,
  sort: "title",
  order: "asc",
});

// Get a single post
const post = await client.api.posts.get("post-id");

// Create a post
const newPost = await client.api.posts.create({
  title: "Hello World",
  body: "My first post",
  authorId: "user-id",
});

// Update a post
const updated = await client.api.posts.update("post-id", {
  title: "Updated Title",
});

// Delete a post
const result = await client.api.posts.delete("post-id");
```

CSRF tokens are handled automatically — the client reads the `csrf_token` cookie and sends it as the `X-CSRF-Token` header on every mutation request. Cookies are sent with `credentials: "include"`.

### Pagination

```ts
let cursor: string | undefined;

do {
  const page = await client.api.posts.list({
    cursor,
    limit: 20,
  });

  console.log(page.data);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

## `auth` — Authentication

### Register

```ts
const { user } = await client.auth.register({
  email: "alice@example.com",
  password: "secret123",
  name: "Alice", // extra fields if required by your users table
});
```

### Login

```ts
const { user } = await client.auth.login({
  email: "alice@example.com",
  password: "secret123",
});
```

### Get current user

```ts
const user = await client.auth.me();
// Returns the user object, or null if not authenticated
```

### Logout

```ts
await client.auth.logout();
```

### Password reset

```ts
// Request a reset email
await client.auth.requestPasswordReset("alice@example.com");

// Reset with the token (from the email link)
await client.auth.resetPassword("reset-token", "newpassword123");
```

### Email verification

```ts
await client.auth.verifyEmail("verification-token");
```

### OAuth

```ts
// Redirect the user to the OAuth provider
window.location.href = client.auth.oauthUrl("google");
// Also: "github", "discord"
```

After the OAuth flow completes, the user is redirected back to your `redirectUrl` with session cookies set.

## `files` — File storage

### Upload a file

```ts
const fileInput = document.querySelector<HTMLInputElement>("#file-input");
const file = fileInput!.files![0];

const result = await client.files.upload("posts", "post-id", file);
// result.file.id — use this to download or delete
```

### Get a download URL

```ts
const url = client.files.downloadUrl("file-id");
// Returns: "http://localhost:3000/files/file-id"
```

### Delete a file

```ts
await client.files.delete("file-id");
```

## Next steps

- [CRUD API](/api/crud/) — endpoint details, filtering operators
- [Auth API](/api/auth/) — auth endpoint reference
- [Files API](/api/files/) — file storage details
