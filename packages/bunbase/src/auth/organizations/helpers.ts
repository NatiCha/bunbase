import { and, eq } from "drizzle-orm";
import type { AnyDb } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";

/**
 * Organization membership helpers.
 * @module
 */

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export async function getOrgMembership(
  db: AnyDb,
  internalSchema: InternalSchema,
  userId: string,
  orgId: string,
): Promise<{ role: string } | null> {
  const members = (internalSchema as any).organizationMembers;
  const rows = await (db as any)
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));

  return rows[0] ?? null;
}

export async function getUserOrganizations(
  db: AnyDb,
  internalSchema: InternalSchema,
  userId: string,
): Promise<Array<{ orgId: string; orgName: string; role: string }>> {
  const members = (internalSchema as any).organizationMembers;
  const orgs = (internalSchema as any).organizations;

  const rows = await (db as any)
    .select({
      orgId: members.orgId,
      orgName: orgs.name,
      role: members.role,
    })
    .from(members)
    .innerJoin(orgs, eq(orgs.id, members.orgId))
    .where(eq(members.userId, userId));

  return rows;
}

export async function requireOrgRole(
  db: AnyDb,
  internalSchema: InternalSchema,
  userId: string,
  orgId: string,
  minRole: string,
): Promise<{ role: string }> {
  const membership = await getOrgMembership(db, internalSchema, userId, orgId);
  if (!membership) {
    throw Object.assign(new Error("Not a member of this organization"), {
      code: "FORBIDDEN",
      status: 403,
    });
  }

  const userLevel = ROLE_HIERARCHY[membership.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;

  if (userLevel < requiredLevel) {
    throw Object.assign(new Error("Insufficient organization role"), {
      code: "FORBIDDEN",
      status: 403,
    });
  }

  return membership;
}
