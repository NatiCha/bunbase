---
title: Files API
---

TSBase provides file upload, download, and deletion tied to collection records. Files are stored locally or on S3 and tracked in an internal `_files` table.

## Endpoints

### Upload a file

```
POST /files/<collection>/<recordId>
```

Upload a file and associate it with a record in a collection. Requires authentication.

```bash
curl -X POST 'http://localhost:3000/files/posts/post-id-123' \
  -b cookies.txt \
  -F 'file=@photo.jpg'
```

**Response (201):**

```json
{
  "file": {
    "id": "file-uuid",
    "collection": "posts",
    "recordId": "post-id-123",
    "filename": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 204800
  }
}
```

**Validation:**
- The referenced record must exist in the collection
- File size must not exceed `storage.maxFileSize` (default 10 MB)
- If `storage.allowedMimeTypes` is configured, the file's MIME type must be in the list

**Access control:** Uses the collection's `create` rule.

**Errors:**
- `400` — no file, file too large, or MIME type not allowed
- `401` — not authenticated
- `403` — access denied by rule
- `404` — record or collection not found

### Download a file

```
GET /files/<fileId>
```

```bash
curl http://localhost:3000/files/file-uuid -b cookies.txt -o photo.jpg
```

Returns the file content with appropriate `Content-Type` and `Content-Disposition` headers.

**Access control:** Uses the collection's `view`/`get` rule to verify the user can read the associated record.

**Errors:**
- `401` — not authenticated
- `403` — access denied by rule
- `404` — file not found

### Delete a file

```
DELETE /files/<fileId>
```

```bash
curl -X DELETE http://localhost:3000/files/file-uuid -b cookies.txt
```

**Response (200):**

```json
{ "deleted": true }
```

**Access control:** Uses the collection's `delete` rule.

**Errors:**
- `401` — not authenticated
- `403` — access denied by rule
- `404` — file not found

## Storage configuration

### Local storage (default)

Files are stored on the filesystem:

```ts
defineConfig({
  storage: {
    driver: "local",
    localPath: "./data/uploads", // default
  },
});
```

### S3 storage

For production, use S3 or an S3-compatible service (MinIO, R2, etc.):

```ts
defineConfig({
  storage: {
    driver: "s3",
    s3: {
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
      endpoint: "https://...", // optional, for S3-compatible services
    },
  },
});
```

### File size and type limits

```ts
defineConfig({
  storage: {
    maxFileSize: 5 * 1024 * 1024, // 5 MB
    allowedMimeTypes: ["image/png", "image/jpeg", "application/pdf"],
  },
});
```

## File storage path

Files are stored at `<collection>/<recordId>/<fileId><ext>`. For example, a JPEG uploaded to a post record:

```
posts/post-id-123/file-uuid.jpg
```

## Next steps

- [Client SDK](/client/) — use `files.upload()` and `files.downloadUrl()` from the frontend
- [Configuration](/configuration/) — full storage options
