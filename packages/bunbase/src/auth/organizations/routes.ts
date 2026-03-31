import { and, eq, gt } from "drizzle-orm";
import { z } from "zod/v4";
import type { AuthUser } from "../../api/types.ts";
import type { ResolvedConfig } from "../../core/config.ts";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import type { AuthHooks } from "../../hooks/auth-types.ts";
import { validateCsrf } from "../csrf.ts";
import { isBearerOnly } from "../middleware.ts";
import { hashToken } from "../tokens.ts";
import { getOrgMembership, requireOrgRole } from "./helpers.ts";

/**
 * Organization CRUD and membership management routes.
 * @module
 */

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface OrgDeps {
  db: AnyDb;
  internalSchema: InternalSchema;
  config: ResolvedConfig;
  extractAuth: (req: Request) => Promise<AuthUser | null>;
  authHooks?: AuthHooks;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function createOrganizationRoutes(deps: OrgDeps) {
  const { db, internalSchema, config, extractAuth, authHooks } = deps;
  const orgs = (internalSchema as any).organizations;
  const members = (internalSchema as any).organizationMembers;
  const orgInvites = (internalSchema as any).organizationInvites;
  const orgConfig = config.auth.organizations;

  return {
    "/auth/organizations": {
      async POST(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        // Check max orgs per user
        const userOrgs = await (db as any)
          .select({ id: members.id })
          .from(members)
          .where(eq(members.userId, user.id));

        if (userOrgs.length >= orgConfig.maxOrgsPerUser) {
          return jsonError(
            "BAD_REQUEST",
            `Maximum of ${orgConfig.maxOrgsPerUser} organizations reached`,
            400,
          );
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z
          .object({
            name: z.string().min(1).max(255),
            slug: z.string().min(1).max(255).optional(),
          })
          .safeParse(body);

        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }

        const { name } = result.data;
        const slug = result.data.slug ?? slugify(name);

        // Check slug uniqueness
        const existing = await (db as any)
          .select({ id: orgs.id })
          .from(orgs)
          .where(eq(orgs.slug, slug));

        if (existing.length > 0) {
          return jsonError("CONFLICT", "Organization slug already taken", 409);
        }

        const orgId = Bun.randomUUIDv7();
        const now = new Date().toISOString();

        await (db as any).insert(orgs).values({
          id: orgId,
          name,
          slug,
          ownerId: user.id,
          createdAt: now,
          updatedAt: now,
        });

        // Add creator as owner member
        await (db as any).insert(members).values({
          id: Bun.randomUUIDv7(),
          orgId,
          userId: user.id,
          role: "owner",
          createdAt: now,
        });

        if (authHooks?.afterOrgCreate) {
          try {
            await authHooks.afterOrgCreate({
              organization: { id: orgId, name, slug },
              userId: user.id,
            });
          } catch (err) {
            console.error("[BunBase] afterOrgCreate hook error:", err);
          }
        }

        return Response.json(
          {
            organization: {
              id: orgId,
              name,
              slug,
              ownerId: user.id,
              createdAt: now,
              updatedAt: now,
            },
          },
          { status: 201 },
        );
      },

      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const rows = await (db as any)
          .select({
            orgId: members.orgId,
            role: members.role,
            name: orgs.name,
            slug: orgs.slug,
            ownerId: orgs.ownerId,
            createdAt: orgs.createdAt,
          })
          .from(members)
          .innerJoin(orgs, eq(orgs.id, members.orgId))
          .where(eq(members.userId, user.id));

        return Response.json({
          organizations: rows.map((r: any) => ({
            id: r.orgId,
            name: r.name,
            slug: r.slug,
            ownerId: r.ownerId,
            role: r.role,
            createdAt: r.createdAt,
          })),
        });
      },
    },

    "/auth/organizations/:id": {
      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const orgId = new URL(req.url).pathname.split("/").pop()!;

        try {
          await requireOrgRole(db, internalSchema, user.id, orgId, "member");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        const orgRows = await (db as any).select().from(orgs).where(eq(orgs.id, orgId));
        const org = orgRows[0];
        if (!org) return jsonError("NOT_FOUND", "Organization not found", 404);

        const memberRows = await (db as any).select().from(members).where(eq(members.orgId, orgId));

        return Response.json({
          organization: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            ownerId: org.ownerId,
            createdAt: org.createdAt,
            updatedAt: org.updatedAt,
          },
          members: memberRows.map((m: any) => ({
            userId: m.userId,
            role: m.role,
            createdAt: m.createdAt,
          })),
        });
      },

      async PATCH(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const orgId = new URL(req.url).pathname.split("/").pop()!;

        try {
          await requireOrgRole(db, internalSchema, user.id, orgId, "admin");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z.object({ name: z.string().min(1).max(255) }).safeParse(body);
        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }

        await (db as any)
          .update(orgs)
          .set({ name: result.data.name, updatedAt: new Date().toISOString() })
          .where(eq(orgs.id, orgId));

        const updated = await (db as any).select().from(orgs).where(eq(orgs.id, orgId));

        return Response.json({ organization: updated[0] });
      },

      async DELETE(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const orgId = new URL(req.url).pathname.split("/").pop()!;

        try {
          await requireOrgRole(db, internalSchema, user.id, orgId, "owner");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        await (db as any).delete(orgInvites).where(eq(orgInvites.orgId, orgId));
        await (db as any).delete(members).where(eq(members.orgId, orgId));
        await (db as any).delete(orgs).where(eq(orgs.id, orgId));

        return Response.json({ deleted: true });
      },
    },

    "/auth/organizations/:id/members": {
      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const parts = new URL(req.url).pathname.split("/");
        const orgId = parts[parts.length - 2]!;

        try {
          await requireOrgRole(db, internalSchema, user.id, orgId, "member");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        const rows = await (db as any).select().from(members).where(eq(members.orgId, orgId));

        return Response.json({
          members: rows.map((m: any) => ({
            userId: m.userId,
            role: m.role,
            createdAt: m.createdAt,
          })),
        });
      },
    },

    "/auth/organizations/:id/members/:userId": {
      async PATCH(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const authUser = await extractAuth(req);
        if (!authUser) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const parts = new URL(req.url).pathname.split("/");
        const targetUserId = parts.pop()!;
        parts.pop(); // "members"
        const orgId = parts.pop()!;

        try {
          await requireOrgRole(db, internalSchema, authUser.id, orgId, "admin");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z
          .object({ role: z.enum(orgConfig.roles as [string, ...string[]]) })
          .safeParse(body);
        if (!result.success) {
          return jsonError("VALIDATION_ERROR", "Invalid role", 400);
        }

        // Cannot change owner role
        const target = await getOrgMembership(db, internalSchema, targetUserId, orgId);
        if (!target) {
          return jsonError("NOT_FOUND", "Member not found", 404);
        }
        if (target.role === "owner") {
          return jsonError("FORBIDDEN", "Cannot change the owner's role", 403);
        }

        await (db as any)
          .update(members)
          .set({ role: result.data.role })
          .where(and(eq(members.orgId, orgId), eq(members.userId, targetUserId)));

        return Response.json({ member: { userId: targetUserId, role: result.data.role } });
      },

      async DELETE(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const authUser = await extractAuth(req);
        if (!authUser) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const parts = new URL(req.url).pathname.split("/");
        const targetUserId = parts.pop()!;
        parts.pop(); // "members"
        const orgId = parts.pop()!;

        try {
          await requireOrgRole(db, internalSchema, authUser.id, orgId, "admin");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        const target = await getOrgMembership(db, internalSchema, targetUserId, orgId);
        if (!target) {
          return jsonError("NOT_FOUND", "Member not found", 404);
        }
        if (target.role === "owner") {
          return jsonError("FORBIDDEN", "Cannot remove the owner", 403);
        }

        await (db as any)
          .delete(members)
          .where(and(eq(members.orgId, orgId), eq(members.userId, targetUserId)));

        if (authHooks?.afterOrgMemberRemove) {
          try {
            await authHooks.afterOrgMemberRemove({ orgId, userId: targetUserId });
          } catch (err) {
            console.error("[BunBase] afterOrgMemberRemove hook error:", err);
          }
        }

        return Response.json({ removed: true });
      },
    },

    "/auth/organizations/:id/leave": {
      async POST(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const parts = new URL(req.url).pathname.split("/");
        parts.pop(); // "leave"
        const orgId = parts.pop()!;

        const membership = await getOrgMembership(db, internalSchema, user.id, orgId);
        if (!membership) {
          return jsonError("NOT_FOUND", "Not a member of this organization", 404);
        }
        if (membership.role === "owner") {
          return jsonError(
            "FORBIDDEN",
            "Owner cannot leave. Transfer ownership or delete the organization.",
            403,
          );
        }

        await (db as any)
          .delete(members)
          .where(and(eq(members.orgId, orgId), eq(members.userId, user.id)));

        return Response.json({ left: true });
      },
    },

    "/auth/organizations/:id/invites": {
      async POST(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const parts = new URL(req.url).pathname.split("/");
        parts.pop(); // "invites"
        const orgId = parts.pop()!;

        try {
          await requireOrgRole(db, internalSchema, user.id, orgId, "admin");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        const result = z
          .object({
            email: z.email(),
            role: z.enum(orgConfig.roles as [string, ...string[]]).optional(),
          })
          .safeParse(body);

        if (!result.success) {
          return jsonError(
            "VALIDATION_ERROR",
            result.error.issues[0]?.message ?? "Invalid input",
            400,
          );
        }

        const token = Bun.randomUUIDv7();
        const tokenHash = await hashToken(token);
        const id = Bun.randomUUIDv7();
        const expiresAt = Math.floor(Date.now() / 1000) + orgConfig.inviteTtl;

        await (db as any).insert(orgInvites).values({
          id,
          orgId,
          email: result.data.email,
          role: result.data.role ?? "member",
          tokenHash,
          invitedBy: user.id,
          expiresAt,
          createdAt: new Date().toISOString(),
        });

        return Response.json(
          {
            invite: {
              id,
              token,
              email: result.data.email,
              role: result.data.role ?? "member",
              expiresAt,
            },
          },
          { status: 201 },
        );
      },

      async GET(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const parts = new URL(req.url).pathname.split("/");
        parts.pop(); // "invites"
        const orgId = parts.pop()!;

        try {
          await requireOrgRole(db, internalSchema, user.id, orgId, "admin");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        const rows = await (db as any).select().from(orgInvites).where(eq(orgInvites.orgId, orgId));

        return Response.json({
          invites: rows.map((r: any) => ({
            id: r.id,
            email: r.email,
            role: r.role,
            invitedBy: r.invitedBy,
            expiresAt: r.expiresAt,
            createdAt: r.createdAt,
          })),
        });
      },
    },

    "/auth/organizations/:id/invites/:inviteId": {
      async DELETE(req: Request): Promise<Response> {
        if (!isBearerOnly(req) && !validateCsrf(req)) {
          return jsonError("FORBIDDEN", "Invalid CSRF token", 403);
        }

        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

        const parts = new URL(req.url).pathname.split("/");
        const inviteId = parts.pop()!;
        parts.pop(); // "invites"
        const orgId = parts.pop()!;

        try {
          await requireOrgRole(db, internalSchema, user.id, orgId, "admin");
        } catch (err: any) {
          return jsonError(err.code ?? "FORBIDDEN", err.message, err.status ?? 403);
        }

        const rows = await (db as any)
          .select({ id: orgInvites.id })
          .from(orgInvites)
          .where(and(eq(orgInvites.id, inviteId), eq(orgInvites.orgId, orgId)));

        if (rows.length === 0) {
          return jsonError("NOT_FOUND", "Invite not found", 404);
        }

        await (db as any).delete(orgInvites).where(eq(orgInvites.id, inviteId));

        return Response.json({ deleted: true });
      },
    },

    "/auth/organization-invites/accept": {
      async POST(req: Request): Promise<Response> {
        const user = await extractAuth(req);
        if (!user) return jsonError("UNAUTHORIZED", "Not authenticated", 401);

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
          .from(orgInvites)
          .where(and(eq(orgInvites.tokenHash, tokenHash), gt(orgInvites.expiresAt, now)));

        const invite = rows[0];
        if (!invite) {
          return jsonError("BAD_REQUEST", "Invalid or expired invite", 400);
        }

        // Check if email matches
        if (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
          return jsonError("FORBIDDEN", "This invite is for a different email address", 403);
        }

        // Check if already a member
        const existingMembership = await getOrgMembership(
          db,
          internalSchema,
          user.id,
          invite.orgId,
        );
        if (existingMembership) {
          return jsonError("CONFLICT", "Already a member of this organization", 409);
        }

        // Add as member
        await (db as any).insert(members).values({
          id: Bun.randomUUIDv7(),
          orgId: invite.orgId,
          userId: user.id,
          role: invite.role,
          createdAt: new Date().toISOString(),
        });

        // Delete used invite
        await (db as any).delete(orgInvites).where(eq(orgInvites.id, invite.id));

        if (authHooks?.afterOrgMemberAdd) {
          try {
            await authHooks.afterOrgMemberAdd({
              orgId: invite.orgId,
              userId: user.id,
              role: invite.role,
            });
          } catch (err) {
            console.error("[BunBase] afterOrgMemberAdd hook error:", err);
          }
        }

        if (authHooks?.afterOrgInviteAccept) {
          try {
            await authHooks.afterOrgInviteAccept({
              orgId: invite.orgId,
              userId: user.id,
              email: user.email,
            });
          } catch (err) {
            console.error("[BunBase] afterOrgInviteAccept hook error:", err);
          }
        }

        // Fetch org details
        const orgRows = await (db as any).select().from(orgs).where(eq(orgs.id, invite.orgId));

        return Response.json({ organization: orgRows[0] ?? { id: invite.orgId } });
      },
    },
  };
}
