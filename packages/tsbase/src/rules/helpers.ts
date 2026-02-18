import { eq, and, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { RuleContext } from "./types.ts";

// Common rule helpers that users can use in their rule definitions

/** Allow only authenticated users */
export function authenticated(ctx: RuleContext): boolean {
  return ctx.auth !== null;
}

/** Allow only admins */
export function admin(ctx: RuleContext): boolean {
  return ctx.auth?.role === "admin";
}

/** Allow only the record owner (match column value to auth user id) */
export function ownerOnly(
  ownerColumn: SQLiteColumn,
  ctx: RuleContext,
): SQL | boolean {
  if (!ctx.auth) return false;
  return eq(ownerColumn, ctx.auth.id);
}

/** Allow admins or the record owner */
export function adminOrOwner(
  ownerColumn: SQLiteColumn,
  ctx: RuleContext,
): SQL | boolean {
  if (!ctx.auth) return false;
  if (ctx.auth.role === "admin") return true;
  return eq(ownerColumn, ctx.auth.id);
}
