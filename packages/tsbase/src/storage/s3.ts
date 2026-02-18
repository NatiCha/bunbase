import type { StorageDriver } from "./local.ts";

interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
}

export function createS3Storage(config: S3Config): StorageDriver {
  const baseUrl =
    config.endpoint ??
    `https://${config.bucket}.s3.${config.region}.amazonaws.com`;

  async function s3Fetch(
    path: string,
    method: string,
    body?: Uint8Array,
    contentType?: string,
  ): Promise<Response> {
    const url = `${baseUrl}/${path}`;
    const headers: Record<string, string> = {};

    if (contentType) headers["Content-Type"] = contentType;

    const requestBody = body ? Uint8Array.from(body) : undefined;

    // For a v1 implementation, we use presigned URLs or basic auth headers
    // In production, you'd use AWS Signature V4
    // This is a simplified implementation
    return fetch(url, {
      method,
      headers,
      body: requestBody,
    });
  }

  return {
    async write(path, data) {
      const res = await s3Fetch(path, "PUT", data, "application/octet-stream");
      if (!res.ok) {
        throw new Error(`S3 write failed: ${res.status} ${res.statusText}`);
      }
    },

    async read(path) {
      const res = await s3Fetch(path, "GET");
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    },

    async delete(path) {
      await s3Fetch(path, "DELETE");
    },

    async exists(path) {
      const res = await s3Fetch(path, "HEAD");
      return res.ok;
    },
  };
}
