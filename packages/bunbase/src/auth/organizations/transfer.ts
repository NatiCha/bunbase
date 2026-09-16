import { and, eq } from "drizzle-orm";
import { ApiError } from "../../api/helpers.ts";
import type { AnyDb, Dialect } from "../../core/db-types.ts";
import type { InternalSchema } from "../../core/internal-schema.ts";
import { affectedRows } from "../../core/write-result.ts";

/** Transfer ownership as one transaction, with the current owner checked again under the write lock. */
export async function transferOwnership(
  db: AnyDb,
  dialect: Dialect,
  schema: InternalSchema,
  orgId: string,
  ownerId: string,
  targetId: string,
): Promise<void> {
  const { organizations: orgs, organizationMembers: members } = schema;
  const statements = (tx: any) => [
    // This conditional write serializes competing transfers of the same org.
    tx
      .update(orgs)
      .set({ ownerId: targetId, updatedAt: new Date().toISOString() })
      .where(and(eq(orgs.id, orgId), eq(orgs.ownerId, ownerId))),
    tx
      .update(members)
      .set({ role: "owner" })
      .where(and(eq(members.orgId, orgId), eq(members.userId, targetId))),
    tx
      .update(members)
      .set({ role: "admin" })
      .where(and(eq(members.orgId, orgId), eq(members.userId, ownerId), eq(members.role, "owner"))),
  ];
  const check = (result: unknown) => {
    if (affectedRows(result) !== 1) {
      throw new ApiError(
        "CONFLICT",
        "Organization ownership or membership changed. Try again.",
        409,
      );
    }
  };

  if (dialect === "sqlite") {
    // Bun SQLite transactions commit when the callback returns; no promises or
    // awaited queries may escape this callback.
    (db as any).transaction(
      (tx: any) => {
        for (const query of statements(tx)) check(query.run());
      },
      { behavior: "immediate" },
    );
  } else {
    await (db as any).transaction(async (tx: any) => {
      for (const query of statements(tx)) check(await query);
    });
  }
}
