import { and, eq, ne } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import { validateCsrf } from "./csrf.ts";
import { extractSessionId, isBearerOnly } from "./middleware.ts";

/**
 * Session management routes: list, revoke, revoke-others.
 * @module
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface SessionManagementDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
}

export function createSessionManagementRoutes(deps: SessionManagementDeps) {
  const { db, internalSchema, extractAuth } = deps;
  const sessions = internalSchema.sessions;

  return {
    "/auth/sessions": {
      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const currentSessionId = extractSessionId(req);

        const rows = await (db as any)
          .select()
          .from(sessions)
          .where(eq(sessions.userId, user.id));

        const now = Math.floor(Date.now() / 1000);
        const result = rows
          .filter((r: any) => r.expiresAt > now)
          .map((r: any) => ({
            id: r.id,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            userAgent: r.userAgent ?? null,
            ipAddress: r.ipAddress ?? null,
            current: r.id === currentSessionId,
          }));

        return Response.json({ sessions: result });
      },
    },

    "/auth/sessions/:id": {
      async DELETE(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const sessionId = pathParts[pathParts.length - 1]!;
        const currentSessionId = extractSessionId(req);

        if (sessionId === currentSessionId) {
          return jsonError("BAD_REQUEST", "Cannot revoke the current session. Use logout instead.", 400);
        }

        const rows = await (db as any)
          .select({ id: sessions.id, userId: sessions.userId })
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)));

        if (rows.length === 0) {
          return jsonError("NOT_FOUND", "Session not found", 404);
        }

        await (db as any).delete(sessions).where(eq(sessions.id, sessionId));

        return Response.json({ revoked: true });
      },
    },

    "/auth/sessions/revoke-others": {
      async POST(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        const currentSessionId = extractSessionId(req);
        if (!currentSessionId) {
          return jsonError("BAD_REQUEST", "No current session", 400);
        }

        // Count others first
        const others = await (db as any)
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.userId, user.id), ne(sessions.id, currentSessionId)));

        const revokedCount = others.length;

        if (revokedCount > 0) {
          await (db as any)
            .delete(sessions)
            .where(and(eq(sessions.userId, user.id), ne(sessions.id, currentSessionId)));
        }

        return Response.json({ revokedCount });
      },
    },
  };
}
