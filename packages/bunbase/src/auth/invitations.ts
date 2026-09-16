import { and, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import type { AuthUser } from "../api/types.ts";
import type { ResolvedConfig } from "../core/config.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { InternalSchema } from "../core/internal-schema.ts";
import type { AuthHooks } from "../hooks/auth-types.ts";
import { validateCsrf } from "./csrf.ts";
import { isBearerOnly } from "./middleware.ts";
import { hashToken } from "./tokens.ts";

/**
 * Invitation system routes.
 * @module
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface InvitationDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
  authHooks?: AuthHooks;
}

export function createInvitationRoutes(deps: InvitationDeps) {
  const { db, internalSchema, config, extractAuth, authHooks } = deps;
  const invites = (internalSchema as any).invites;
  const inviteConfig = config.auth.invitations;

  return {
    "/auth/invites": {
      async POST(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        if (user.role !== "admin") {
          return jsonError("FORBIDDEN", "Admin access required", 403);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z
          .object({
            email: z.email().optional(),
            role: z.string().optional(),
            maxUses: z.number().int().min(1).optional(),
          })
          .safeParse(body);

        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }

        const { email, role, maxUses } = result.data;
        const token = Bun.randomUUIDv7();
        const tokenHash = await hashToken(token);
        const id = Bun.randomUUIDv7();
        const expiresAt = Math.floor(Date.now() / 1000) + inviteConfig.ttl;

        await (db as any).insert(invites).values({
          id,
          email: email ?? null,
          tokenHash,
          role: role ?? "user",
          invitedBy: user.id,
          maxUses: maxUses ?? inviteConfig.maxUsesDefault,
          useCount: 0,
          expiresAt,
          createdAt: new Date().toISOString(),
        });

        if (authHooks?.afterInviteCreate) {
          try {
            await authHooks.afterInviteCreate({ inviteId: id, email, invitedBy: user.id });
          } catch (err) {
            console.error("[BunBase] afterInviteCreate hook error:", err);
          }
        }

        return Response.json(
          {
            invite: {
              id,
              token, // Only returned once
              email: email ?? null,
              role: role ?? "user",
              maxUses: maxUses ?? inviteConfig.maxUsesDefault,
              expiresAt,
            },
          },
          { status: 201 },
        );
      },

      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        if (user.role !== "admin") {
          return jsonError("FORBIDDEN", "Admin access required", 403);
        }

        const rows = await (db as any).select().from(invites);

        return Response.json({
          invites: rows.map((r: any) => ({
            id: r.id,
            email: r.email,
            role: r.role,
            invitedBy: r.invitedBy,
            maxUses: r.maxUses,
            useCount: r.useCount,
            expiresAt: r.expiresAt,
            createdAt: r.createdAt,
          })),
        });
      },
    },

    "/auth/invites/:id": {
      async DELETE(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) {
          return jsonError("UNAUTHORIZED", "Not authenticated", 401);
        }

        if (user.role !== "admin") {
          return jsonError("FORBIDDEN", "Admin access required", 403);
        }

        const url = new URL(req.url);
        const pathParts = url.pathname.split("/");
        const inviteId = pathParts[pathParts.length - 1]!;

        const rows = await (db as any)
          .select({ id: invites.id })
          .from(invites)
          .where(eq(invites.id, inviteId));

        if (rows.length === 0) {
          return jsonError("NOT_FOUND", "Invite not found", 404);
        }

        await (db as any).delete(invites).where(eq(invites.id, inviteId));

        return Response.json({ deleted: true });
      },
    },

    "/auth/invites/validate": {
      async POST(req: Request): Promise<Response> {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z.object({ token: z.string() }).safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Token is required", 400);
        }

        const tokenHash = await hashToken(result.data.token);
        const now = Math.floor(Date.now() / 1000);

        const rows = await (db as any)
          .select()
          .from(invites)
          .where(and(eq(invites.tokenHash, tokenHash), gt(invites.expiresAt, now)));

        const invite = rows[0];
        if (!invite) {
          return Response.json({ valid: false });
        }

        if (invite.maxUses > 0 && invite.useCount >= invite.maxUses) {
          return Response.json({ valid: false });
        }

        return Response.json({ valid: true, email: invite.email ?? undefined });
      },
    },
  };
}

/**
 * Validate and consume an invite token during registration.
 * Returns the invite row if valid, or null if invalid.
 */
export async function validateAndConsumeInvite(
  db: AnyDb,
  internalSchema: InternalSchema,
  inviteCode: string,
  email: string,
): Promise<{ role: string } | null> {
  const invites = (internalSchema as any).invites;
  const tokenHash = await hashToken(inviteCode);
  const now = Math.floor(Date.now() / 1000);

  const rows = await (db as any)
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, tokenHash), gt(invites.expiresAt, now)));

  const invite = rows[0];
  if (!invite) return null;

  // Check email match if invite is email-specific
  if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) return null;

  // Atomically claim a use slot. The conditional WHERE guards against a
  // TOCTOU race where two concurrent registrations both pass the maxUses check
  // and then each increment, overshooting maxUses. maxUses <= 0 means unlimited.
  const prevUseCount = invite.useCount as number;
  const maxUses = invite.maxUses as number;

  if (maxUses > 0) {
    // Compare-and-swap on the exact use_count we read. Portable across all three
    // dialects (no reliance on affected-row counts). If a concurrent claim won
    // the slot, our CAS matches zero rows and the re-read below will not show
    // our increment, so we treat it as exhausted.
    await (db as any)
      .update(invites)
      .set({ useCount: sql`${invites.useCount} + 1` })
      .where(
        and(
          eq(invites.id, invite.id),
          eq(invites.useCount, prevUseCount),
          lt(invites.useCount, maxUses),
        ),
      );

    const afterRows = await (db as any)
      .select({ useCount: invites.useCount })
      .from(invites)
      .where(eq(invites.id, invite.id));
    const afterUseCount = afterRows[0]?.useCount as number | undefined;
    if (afterUseCount !== prevUseCount + 1) {
      // CAS lost the race (or invite vanished) — slot not claimed by us.
      return null;
    }
  } else {
    // Unlimited invite — still bump the counter for accounting.
    await (db as any)
      .update(invites)
      .set({ useCount: sql`${invites.useCount} + 1` })
      .where(eq(invites.id, invite.id));
  }

  return { role: invite.role };
}
