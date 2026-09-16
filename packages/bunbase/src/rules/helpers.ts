import type { Column, Table } from "drizzle-orm";
import { eq, type SQL, sql } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";
import type { AnyDb } from "../core/db-types.ts";
import type { TableRules } from "./types.ts";

// Common rule helpers that users can use in their rule definitions

/** Allow only authenticated users */
export function authenticated(auth: AuthUser | null): boolean {
  return auth !== null;
}

/** Allow only admins */
export function admin(auth: AuthUser | null): boolean {
  return auth?.role === "admin";
}

/** Allow only the record owner (match column value to auth user id) */
export function ownerOnly(ownerColumn: Column, auth: AuthUser | null): SQL | boolean {
  if (!auth) return false;
  return eq(ownerColumn, auth.id);
}

/** Allow admins or the record owner */
export function adminOrOwner(ownerColumn: Column, auth: AuthUser | null): SQL | boolean {
  if (!auth) return false;
  if (auth.role === "admin") return true;
  return eq(ownerColumn, auth.id);
}

/**
 * Allow all operations on a table with no restrictions.
 * Use this to explicitly mark a table as fully public.
 * Without any rules, operations are denied by default.
 *
 * @example
 * defineRules({ announcements: allowAll })
 */
export const allowAll: TableRules = {
  list: () => true,
  get: () => true,
  create: () => true,
  update: () => true,
  delete: () => true,
};

/** Check if a field was submitted in the request body */
export function isSet(body: Record<string, unknown>, field: string): boolean {
  return field in body;
}

/**
 * Check if a field was submitted AND differs from the existing record value.
 * Returns false if the field is not in the body.
 * Returns true if the record is missing (no existing state to compare).
 */
export function isChanged(
  body: Record<string, unknown>,
  record: Record<string, unknown> | undefined,
  field: string,
): boolean {
  if (!(field in body)) return false;
  if (!record) return true;
  return body[field] !== record[field];
}

/**
 * Return the length of an array field on an existing record.
 * Returns 0 if the record is missing or the field is not an array.
 */
export function fieldLength(record: Record<string, unknown> | undefined, field: string): number {
  if (!record) return 0;
  const val = record[field];
  if (Array.isArray(val)) return val.length;
  return 0;
}

/**
 * Cross-table query helper for use in rules.
 * Returns all rows from a table matching the given WHERE clause.
 */
export function collection(
  db: AnyDb,
  table: Table,
  where: SQL,
): Promise<Record<string, unknown>[]> {
  return (db as any).select().from(table).where(where);
}

/** Return the current date and time */
export function now(): Date {
  return new Date();
}

/** Return the start of today (midnight) */
export function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Return the end of today (23:59:59.999) */
export function todayEnd(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Return the first moment of the current month */
export function monthStart(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Return the first moment of the current year */
export function yearStart(): Date {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Resolve membership from the current request's database, never from user-supplied claims. */
async function hasOrgRole(
  orgId: string | null | undefined,
  auth: AuthUser | null,
  db: AnyDb,
  roles: readonly string[],
): Promise<boolean> {
  // Missing db also denies legacy JavaScript calls that omit the new argument.
  if (!auth || !orgId || !db) return false;
  const members = sql.identifier("_organization_members");
  const rows = await (db as any)
    .select({ role: sql<string>`${sql.identifier("role")}` })
    .from(members)
    .where(
      sql`${sql.identifier("org_id")} = ${orgId} and ${sql.identifier("user_id")} = ${auth.id}`,
    )
    .limit(1);
  return roles.includes(rows[0]?.role);
}

/**
 * Require persisted membership in the target organization.
 * Return or await this promise in a rule:
 * `update: ({ record, auth, db }) => orgMember(record?.orgId, auth, db)`.
 */
export function orgMember(
  orgId: string | null | undefined,
  auth: AuthUser | null,
  db: AnyDb,
): Promise<boolean> {
  return hasOrgRole(orgId, auth, db, ["member", "admin", "owner"]);
}

/** Require a persisted admin or owner membership in the target organization. */
export function orgAdmin(
  orgId: string | null | undefined,
  auth: AuthUser | null,
  db: AnyDb,
): Promise<boolean> {
  return hasOrgRole(orgId, auth, db, ["admin", "owner"]);
}

/** Require a persisted owner membership in the target organization. */
export function orgOwner(
  orgId: string | null | undefined,
  auth: AuthUser | null,
  db: AnyDb,
): Promise<boolean> {
  return hasOrgRole(orgId, auth, db, ["owner"]);
}
