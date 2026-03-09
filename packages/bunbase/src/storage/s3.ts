import type { StorageDriver } from "./local.ts";

/**
 * S3-compatible storage driver (AWS SigV4 signed requests).
 * @module
 */

interface S3Config {
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
}

const enc = new TextEncoder();

function buildUrl(config: S3Config, key: string): string {
  const k = key.replace(/^\//, "");
  if (config.endpoint) {
    return `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${k}`;
  }
  const region = config.region ?? "us-east-1";
  return `https://${config.bucket}.s3.${region}.amazonaws.com/${k}`;
}

function toHex(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(data: Uint8Array<ArrayBufferLike> | string): Promise<string> {
  const input = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", input));
}

async function hmac(key: Uint8Array<ArrayBufferLike>, msg: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

async function sigv4Headers(
  method: string,
  url: URL,
  body: Uint8Array<ArrayBufferLike>,
  config: S3Config,
): Promise<Record<string, string>> {
  const region = config.region ?? "us-east-1";
  const now = new Date();
  // yyyymmddTHHMMSSZ
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStr = amzDate.slice(0, 8);

  const payloadHash = await sha256(body);
  const signedHeaderNames = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method,
    url.pathname,
    url.search ? url.search.slice(1) : "",
    `host:${url.hostname}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}`,
    "",
    signedHeaderNames,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStr}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join("\n");

  // Derive signing key
  let signingKey = await hmac(enc.encode(`AWS4${config.secretAccessKey}`), dateStr);
  signingKey = await hmac(signingKey, region);
  signingKey = await hmac(signingKey, "s3");
  signingKey = await hmac(signingKey, "aws4_request");

  const signature = toHex(await hmac(signingKey, stringToSign));

  return {
    host: url.hostname,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
  };
}

/** Create an S3-backed storage driver. */
export function createS3Storage(config: S3Config): StorageDriver {
  async function s3Fetch(
    method: string,
    key: string,
    body: Uint8Array<ArrayBufferLike> = new Uint8Array(new ArrayBuffer(0)),
  ): Promise<Response> {
    const url = new URL(buildUrl(config, key));
    const headers = await sigv4Headers(method, url, body, config);
    return fetch(url.toString(), {
      method,
      headers,
      body: body.length ? body : undefined,
    });
  }

  return {
    async write(path, data) {
      const res = await s3Fetch("PUT", path, data);
      if (!res.ok) throw new Error("S3 write failed");
    },

    async read(path) {
      const res = await s3Fetch("GET", path);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf) as unknown as Uint8Array<ArrayBuffer>;
    },

    async delete(path) {
      await s3Fetch("DELETE", path);
    },

    async exists(path) {
      const res = await s3Fetch("HEAD", path);
      return res.ok;
    },
  };
}
