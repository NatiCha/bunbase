import { eq } from "drizzle-orm";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";

/**
 * JWT sign/verify using Web Crypto API (HMAC-SHA256).
 * @module
 */

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  jti: string;
  iat: number;
  exp: number;
  type: "access" | "refresh";
  mfaVerified?: boolean;
}

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function getSigningKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp" | "jti">,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jti = Bun.randomUUIDv7();

  const fullPayload: JwtPayload = {
    ...payload,
    jti,
    iat: now,
    exp: now + ttlSeconds,
  };

  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify(fullPayload)));
  const signingInput = `${header}.${body}`;

  const key = await getSigningKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)));

  return `${signingInput}.${base64url(signature)}`;
}

export async function verifyJwt(
  token: string,
  secret: string,
  db?: AnyDb,
  internalSchema?: InternalSchema,
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const signingInput = `${header}.${body}`;

  const enc = new TextEncoder();
  const key = await getSigningKey(secret);

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64urlDecode(sig!),
    enc.encode(signingInput),
  );

  if (!valid) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body!)));
  } catch {
    return null;
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;

  // Check revocation if DB is available
  if (db && internalSchema && (internalSchema as any).jwtRevocations) {
    const revoked = await (db as any)
      .select({ jti: (internalSchema as any).jwtRevocations.jti })
      .from((internalSchema as any).jwtRevocations)
      .where(eq((internalSchema as any).jwtRevocations.jti, payload.jti));

    if (revoked.length > 0) return null;
  }

  return payload;
}

export async function revokeJwt(
  db: AnyDb,
  internalSchema: InternalSchema,
  jti: string,
  expiresAt: number,
): Promise<void> {
  const revocations = (internalSchema as any).jwtRevocations;
  await (db as any).insert(revocations).values({
    id: Bun.randomUUIDv7(),
    jti,
    expiresAt,
    createdAt: new Date().toISOString(),
  });
}

/** Check if a token string looks like a JWT (has 3 dot-separated parts). */
export function isJwtToken(token: string): boolean {
  return token.split(".").length === 3;
}
