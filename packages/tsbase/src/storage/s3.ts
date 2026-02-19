import { S3Client } from "bun";
import type { StorageDriver } from "./local.ts";

interface S3Config {
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
}

export function createS3Storage(config: S3Config): StorageDriver {
  const client = new S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
  });

  return {
    async write(path, data) {
      await client.write(path, data);
    },

    async read(path) {
      const file = client.file(path);
      if (!(await file.exists())) return null;
      return file.bytes();
    },

    async delete(path) {
      await client.delete(path);
    },

    async exists(path) {
      return client.exists(path);
    },
  };
}
