import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AuthUser } from "../api/types.ts";
import { validateCsrf } from "./csrf.ts";
import { isBearerOnly } from "./middleware.ts";

/**
 * API key lifecycle helpers and auth routes.
 * @module
 */

export async function deleteUserApiKeys(
  db: AnyDb,
  schema: InternalSchema,
  userId: string,
): Promise<void> {
  await (db as any)
    .delete(schema.apiKeys)
    .where(eq(schema.apiKeys.userId, userId));
}

interface ApiKeyRoutesDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  usersTable: any;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function generateApiKey(): { rawKey: string; keyPrefix: string } {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rawKey = `bb_live_${hex}`;
  const keyPrefix = `bb_live_${hex.slice(0, 8)}`;
  return { rawKey, keyPrefix };
}

function hashApiKey(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return hasher.digest("hex");
}

/**
 * Create API key CRUD routes.
 */
export function createApiKeyRoutes(deps: ApiKeyRoutesDeps) {
  const { db, internalSchema, config, extractAuth } = deps;

  return {
    "/auth/api-keys": {
      async POST(req: Request): Promise<Response> {
        // Manual CSRF check — skip when bearer token is the sole auth mechanism
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const schema = z.object({
          name: z.string().min(1).max(255),
          expiresInDays: z.number().int().min(0).optional(),
        });

        const result = schema.safeParse(body);
        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }

        const { name, expiresInDays } = result.data;
        const { defaultExpirationDays, maxExpirationDays } = config.auth.apiKeys;
        const { rawKey, keyPrefix } = generateApiKey();
        const keyHash = hashApiKey(rawKey);
        const id = Bun.randomUUIDv7();
        const createdAt = new Date().toISOString();

        // Expiration precedence:
        // 1) explicit expiresInDays
        // 2) config defaultExpirationDays
        // `0` means "no expiration"
        let expiresAt: number | null;
        if (expiresInDays === 0) {
          // Explicit infinite — bypasses max check
          expiresAt = null;
        } else if (expiresInDays === undefined) {
          // Apply config default
          if (defaultExpirationDays === 0) {
            expiresAt = null;
          } else {
            expiresAt = Math.floor(Date.now() / 1000) + defaultExpirationDays * 86400;
          }
        } else {
          // Explicit positive value — enforce cap if set
          if (maxExpirationDays !== null && expiresInDays > maxExpirationDays) {
            return jsonError(
              "VALIDATION_ERROR",
              `Expiration exceeds maximum allowed days (${maxExpirationDays})`,
              400,
            );
          }
          expiresAt = Math.floor(Date.now() / 1000) + expiresInDays * 86400;
        }

        await (db as any).insert(internalSchema.apiKeys).values({
          id,
          userId: user.id,
          keyHash,
          keyPrefix,
          name,
          expiresAt,
          lastUsedAt: null,
          createdAt,
        });

        return Response.json(
          {
            id,
            name,
            keyPrefix,
            key: rawKey, // only returned once at creation
            expiresAt,
            createdAt,
          },
          { status: 201 },
        );
      },

      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const rows = await (db as any)
          .select({
            id: internalSchema.apiKeys.id,
            userId: internalSchema.apiKeys.userId,
            keyPrefix: internalSchema.apiKeys.keyPrefix,
            name: internalSchema.apiKeys.name,
            expiresAt: internalSchema.apiKeys.expiresAt,
            lastUsedAt: internalSchema.apiKeys.lastUsedAt,
            createdAt: internalSchema.apiKeys.createdAt,
          })
          .from(internalSchema.apiKeys)
          .where(eq(internalSchema.apiKeys.userId, user.id))
          ;

        return Response.json(rows);
      },
    },

    "/auth/api-keys/:id": {
      async DELETE(req: Request): Promise<Response> {
        // Manual CSRF check — skip when bearer token is the sole auth mechanism
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        // Extract key id from URL path
        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const keyId = pathParts[pathParts.length - 1];

        const rows = await (db as any)
          .select({
            id: internalSchema.apiKeys.id,
            userId: internalSchema.apiKeys.userId,
          })
          .from(internalSchema.apiKeys)
          .where(eq(internalSchema.apiKeys.id, keyId))
          ;

        const keyRow = rows[0];
        if (!keyRow) {
          return jsonError("NOT_FOUND", "API key not found", 404);
        }

        // Only the owning user or an admin can revoke
        if (keyRow.userId !== user.id && user.role !== "admin") {
          return jsonError("FORBIDDEN", "Cannot delete another user's API key", 403);
        }

        await (db as any)
          .delete(internalSchema.apiKeys)
          .where(eq(internalSchema.apiKeys.id, keyId))
          ;

        return Response.json({ deleted: true });
      },
    },
  };
}
