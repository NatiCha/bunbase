---
title: CRUD API
---

TSBase auto-generates five tRPC endpoints for every table in your schema: `list`, `get`, `create`, `update`, and `delete`. All endpoints are available under `/trpc/<table>.<operation>`.

## Endpoints

Using the `posts` table as an example:

### List records

```
GET /trpc/posts.list?input=<encoded-json>
```

Query parameters are JSON-encoded in the `input` param. For simple requests with no filters:

```bash
curl 'http://localhost:3000/trpc/posts.list'
```

With filters and pagination:

```bash
curl 'http://localhost:3000/trpc/posts.list?input=%7B%22filter%22%3A%7B%22published%22%3A1%7D%2C%22limit%22%3A10%7D'
```

**Response:**

```json
{
  "result": {
    "data": {
      "data": [
        { "id": "...", "title": "Hello", "body": "...", "authorId": "..." }
      ],
      "nextCursor": "eyJpZCI6Ii4uLiJ9",
      "hasMore": true
    }
  }
}
```

**Input parameters:**

| Field | Type | Description |
|---|---|---|
| `filter` | `object` | Filter conditions (see Filtering below) |
| `cursor` | `string` | Cursor for pagination |
| `limit` | `number` | Results per page (1–100, default 20) |
| `sort` | `string` | Column name to sort by |
| `order` | `"asc" \| "desc"` | Sort direction (default `"asc"`) |

### Get a record

```
GET /trpc/posts.get?input={"id":"<post-id>"}
```

```bash
curl 'http://localhost:3000/trpc/posts.get?input=%7B%22id%22%3A%22abc123%22%7D'
```

Returns the record or `null` if not found.

### Create a record

```
POST /trpc/posts.create
```

```bash
curl -X POST 'http://localhost:3000/trpc/posts.create' \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token>" \
  -b cookies.txt \
  -d '{"title": "My Post", "body": "Content here", "authorId": "user-id"}'
```

- `id` is auto-generated (UUIDv7) if not provided
- `created_at` and `updated_at` are set automatically

### Update a record

```
POST /trpc/posts.update
```

```bash
curl -X POST 'http://localhost:3000/trpc/posts.update' \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token>" \
  -b cookies.txt \
  -d '{"id": "post-id", "data": {"title": "Updated Title"}}'
```

- Only include fields you want to change in `data`
- `updated_at` is set automatically

### Delete a record

```
POST /trpc/posts.delete
```

```bash
curl -X POST 'http://localhost:3000/trpc/posts.delete' \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <token>" \
  -b cookies.txt \
  -d '{"id": "post-id"}'
```

Returns `{ "deleted": true }` or `{ "deleted": false }` if the record was not found.

## Filtering

The `filter` parameter supports direct value matching and operator-based filtering.

### Direct match

```json
{ "filter": { "authorId": "user-123" } }
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
  "filter": {
    "authorId": "user-123",
    "published": { "eq": 1 },
    "title": { "contains": "tutorial" }
  }
}
```

## Pagination

TSBase uses cursor-based pagination for efficient traversal of large datasets.

### Basic pagination

```json
{ "limit": 10 }
```

### Using cursors

The `list` response includes `nextCursor` and `hasMore`. Pass `nextCursor` back to get the next page:

```json
{ "cursor": "eyJpZCI6Ii4uLiJ9", "limit": 10 }
```

### Sorting with pagination

When sorting by a field, the cursor tracks both the sort value and the ID for stable ordering:

```json
{ "sort": "title", "order": "asc", "limit": 10 }
```

## CSRF protection

All mutation endpoints (`create`, `update`, `delete`) require a CSRF token. After login, a `csrf_token` cookie is set. Include it as the `X-CSRF-Token` header:

```bash
curl -X POST 'http://localhost:3000/trpc/posts.create' \
  -H "X-CSRF-Token: <csrf-token-from-cookie>" \
  -b cookies.txt \
  -d '...'
```

## Next steps

- [Rules](/rules/) — control access per operation
- [Client SDK](/client/) — use the type-safe client instead of curl
