---
title: CRUD API
---

TSBase auto-generates five REST endpoints for every table in your schema: `list`, `get`, `create`, `update`, and `delete`.

## Endpoints

Using the `posts` table as an example:

### List records

```
GET /api/posts
```

Query parameters:

| Parameter | Type | Description |
|---|---|---|
| `filter` | `string` (JSON) | Filter conditions (see Filtering below) |
| `cursor` | `string` | Cursor for pagination |
| `limit` | `number` | Results per page (1–100, default 20) |
| `sort` | `string` | Column name to sort by |
| `order` | `"asc" \| "desc"` | Sort direction (default `"asc"`) |

```bash
curl 'http://localhost:3000/api/posts'
```

With filters and pagination:

```bash
curl 'http://localhost:3000/api/posts?filter={"published":1}&limit=10'
```

**Response:**

```json
{
  "data": [
    { "id": "...", "title": "Hello", "body": "...", "authorId": "..." }
  ],
  "nextCursor": "eyJpZCI6Ii4uLiJ9",
  "hasMore": true
}
```

### Get a record

```
GET /api/posts/:id
```

```bash
curl 'http://localhost:3000/api/posts/abc123'
```

Returns the record or `null` if not found.

### Create a record

```
POST /api/posts
```

```bash
curl -X POST 'http://localhost:3000/api/posts' \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token>" \
  -b cookies.txt \
  -d '{"title": "My Post", "body": "Content here", "authorId": "user-id"}'
```

- `id` is auto-generated (UUIDv7) if not provided
- `created_at` and `updated_at` are set automatically

Returns the created record with status `201`.

### Update a record

```
PATCH /api/posts/:id
```

```bash
curl -X PATCH 'http://localhost:3000/api/posts/post-id' \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token>" \
  -b cookies.txt \
  -d '{"title": "Updated Title"}'
```

- Only include fields you want to change
- `updated_at` is set automatically

### Delete a record

```
DELETE /api/posts/:id
```

```bash
curl -X DELETE 'http://localhost:3000/api/posts/post-id' \
  -H "X-CSRF-Token: <token>" \
  -b cookies.txt
```

Returns `{ "deleted": true }` or `{ "deleted": false }` if the record was not found.

## Filtering

The `filter` query parameter accepts a JSON object with direct value matching or operator-based conditions.

### Direct match

```json
{ "authorId": "user-123" }
```

### Operators

| Operator | SQL Equivalent | Example |
|---|---|---|
| `eq` | `=` | `{ "title": { "eq": "Hello" } }` |
| `ne` | `!=` | `{ "role": { "ne": "admin" } }` |
| `gt` | `>` | `{ "age": { "gt": 18 } }` |
| `gte` | `>=` | `{ "age": { "gte": 18 } }` |
| `lt` | `<` | `{ "price": { "lt": 100 } }` |
| `lte` | `<=` | `{ "price": { "lte": 100 } }` |
| `contains` | `LIKE %val%` | `{ "title": { "contains": "hello" } }` |
| `startsWith` | `LIKE val%` | `{ "name": { "startsWith": "A" } }` |
| `endsWith` | `LIKE %val` | `{ "email": { "endsWith": ".com" } }` |
| `in` | `IN (...)` | `{ "status": { "in": ["draft", "published"] } }` |
| `notIn` | `NOT IN (...)` | `{ "role": { "notIn": ["banned"] } }` |
| `isNull` | `IS NULL` / `IS NOT NULL` | `{ "deletedAt": { "isNull": true } }` |

Multiple filters are combined with AND:

```json
{
  "authorId": "user-123",
  "published": { "eq": 1 },
  "title": { "contains": "tutorial" }
}
```

## Pagination

TSBase uses cursor-based pagination for efficient traversal of large datasets.

### Basic pagination

```
GET /api/posts?limit=10
```

### Using cursors

The `list` response includes `nextCursor` and `hasMore`. Pass `nextCursor` back to get the next page:

```
GET /api/posts?cursor=eyJpZCI6Ii4uLiJ9&limit=10
```

### Sorting with pagination

When sorting by a field, the cursor tracks both the sort value and the ID for stable ordering:

```
GET /api/posts?sort=title&order=asc&limit=10
```

## CSRF protection

All mutation endpoints (`POST`, `PATCH`, `DELETE`) require a CSRF token. After login, a `csrf_token` cookie is set. Include it as the `X-CSRF-Token` header:

```bash
curl -X POST 'http://localhost:3000/api/posts' \
  -H "X-CSRF-Token: <csrf-token-from-cookie>" \
  -b cookies.txt \
  -d '...'
```

## Next steps

- [Rules](/rules/) — control access per operation
- [Client SDK](/client/) — use the type-safe client instead of curl
