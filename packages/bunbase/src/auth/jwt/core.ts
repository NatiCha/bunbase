import { createHash } from "node:crypto";
import { eq, or, sql } from "drizzle-orm";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";

/**
 * JWT sign/verify using Web Crypto API (HMAC-SHA256).
 * @module
 */

export interface JwtPayload {
  iss: string;
  aud: string;
  fid: string;
  sub: string;
  email: string;
  role: string;
  jti: string;
  iat: number;
  exp: number;
  type: "access" | "refresh";
  mfaVerified?: boolean;
}

// Fractional NumericDate avoids a one-second gap between revocation and a fresh
// login. Use the same clock for both issuance and revocation.
function jwtTime(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}

function userRevocationId(userId: string): string {
  return `user:${createHash("sha256").update(userId).digest("hex")}`;
}

/** Invalidate all tokens issued for a user so far, including refresh tokens. */
export async function revokeUserJwts(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
): Promise<void> {
  const table = schema.jwtRevocations;
  const id = userRevocationId(userId);
  // Fixed-width numeric text keeps comparisons portable across database dialects.
  const cutoff = jwtTime().toFixed(6).padStart(24, "0");
  const createdAt = sql`CASE WHEN ${table.createdAt} < ${cutoff} THEN ${cutoff} ELSE ${table.createdAt} END`;
  const insert = (db as any).insert(table).values({
    id,
    jti: id,
    createdAt: cutoff,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  if (typeof insert.onConflictDoUpdate === "function") {
    await insert.onConflictDoUpdate({ target: table.id, set: { createdAt } });
  } else {
    await insert.onDuplicateKeyUpdate({ set: { createdAt } });
  }
}

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
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
  payload: Omit<JwtPayload, "iat" | "exp" | "jti" | "iss" | "aud" | "fid"> &
    Partial<Pick<JwtPayload, "iss" | "aud" | "fid">>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const now = jwtTime();
  const jti = Bun.randomUUIDv7();

  const fullPayload: JwtPayload = {
    ...payload,
    iss: payload.iss ?? "bunbase",
    aud: payload.aud ?? "bunbase",
    fid: payload.fid ?? crypto.randomUUID(),
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
  expected: { issuer?: string; audience?: string } = {},
): Promise<JwtPayload | null> {
  let payload: JwtPayload;
  try {
    if (typeof token !== "string" || token.length > 16384) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const [header, body, signature] = parts as [string, string, string];
    const parsedHeader = JSON.parse(new TextDecoder().decode(base64urlDecode(header)));
    if (
      parsedHeader?.alg !== "HS256" ||
      parsedHeader?.typ !== "JWT" ||
      parsedHeader.crit !== undefined
    )
      return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await getSigningKey(secret),
      base64urlDecode(signature),
      new TextEncoder().encode(`${header}.${body}`),
    );
    if (!valid) return null;
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body)));
    if (
      !payload ||
      !Number.isFinite(payload.exp) ||
      !Number.isFinite(payload.iat) ||
      payload.exp <= jwtTime() ||
      payload.iat > jwtTime() + 30 ||
      payload.exp <= payload.iat ||
      ![payload.sub, payload.jti, payload.fid, payload.email, payload.role].every(
        (v) => typeof v === "string",
      ) ||
      !payload.sub ||
      !payload.jti ||
      !payload.fid ||
      (payload.type !== "access" && payload.type !== "refresh") ||
      (payload.mfaVerified !== undefined && typeof payload.mfaVerified !== "boolean") ||
      payload.iss !== (expected.issuer ?? "bunbase") ||
      payload.aud !== (expected.audience ?? "bunbase")
    )
      return null;
  } catch {
    return null;
  }

  // Check revocation if DB is available
  if (db && internalSchema && (internalSchema as any).jwtRevocations) {
    const revoked = await (db as any)
      .select()
      .from((internalSchema as any).jwtRevocations)
      .where(
        or(
          eq(internalSchema.jwtRevocations.jti, payload.jti),
          eq(internalSchema.jwtRevocations.id, userRevocationId(payload.sub)),
          eq(internalSchema.jwtRevocations.id, familyRevocationId(payload.fid)),
        ),
      );

    if (
      revoked.some(
        (row: { jti: string; createdAt: string }) =>
          row.jti === payload.jti ||
          row.jti === familyRevocationId(payload.fid) ||
          payload.iat <= Number(row.createdAt),
      )
    )
      return null;
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

function familyRevocationId(family: string): string {
  return `family:${createHash("sha256").update(family).digest("hex")}`;
}
function duplicateKey(error: unknown): boolean {
  for (let depth = 0; error && typeof error === "object" && depth < 5; depth++) {
    const e = error as {
      code?: string;
      errno?: number | string;
      message?: string;
      cause?: unknown;
    };
    if (
      e.code === "23505" ||
      e.errno === "23505" ||
      e.code === "ER_DUP_ENTRY" ||
      e.errno === 1062 ||
      e.message?.includes("UNIQUE constraint failed")
    )
      return true;
    error = e.cause;
  }
  return false;
}
export async function revokeJwtFamily(
  db: AnyDb,
  schema: InternalSchema,
  family: string,
): Promise<void> {
  const id = familyRevocationId(family);
  try {
    await (db as any).insert(schema.jwtRevocations).values({
      id,
      jti: id,
      createdAt: new Date().toISOString(),
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }
}
/** Atomic claim: the unique JTI index makes concurrent refreshes single use. */
export async function consumeRefreshJwt(
  db: AnyDb,
  schema: InternalSchema,
  payload: JwtPayload,
): Promise<boolean> {
  try {
    await (db as any).insert(schema.jwtRevocations).values({
      id: `refresh:${createHash("sha256").update(payload.jti).digest("hex")}`,
      jti: payload.jti,
      createdAt: new Date().toISOString(),
      expiresAt: Math.ceil(payload.exp),
    });
    return true;
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    await revokeJwtFamily(db, schema, payload.fid);
    return false;
  }
}

export async function isJwtUserRevoked(
  db: AnyDb,
  schema: InternalSchema,
  payload: JwtPayload,
): Promise<boolean> {
  const rows = await (db as any)
    .select()
    .from(schema.jwtRevocations)
    .where(eq(schema.jwtRevocations.id, userRevocationId(payload.sub)));
  return rows.some((row: { createdAt: string }) => payload.iat <= Number(row.createdAt));
}
