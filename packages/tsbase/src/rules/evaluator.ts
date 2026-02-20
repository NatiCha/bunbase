import type { SQL } from "drizzle-orm";
import type { RuleFunction, RuleResult, RuleContext } from "./types.ts";

export interface EvaluatedRule {
  allowed: boolean;
  whereClause?: SQL;
}

export async function evaluateRule(
  rule: RuleFunction | undefined,
  ctx: RuleContext,
): Promise<EvaluatedRule> {
  if (!rule) {
    // No rule defined = deny by default
    return { allowed: false };
  }

  const result: RuleResult = await rule(ctx);

  // null = no restriction
  if (result === null) {
    return { allowed: true };
  }

  // boolean = gate
  if (typeof result === "boolean") {
    return { allowed: result };
  }

  // SQL = WHERE clause (allowed, but filtered)
  return { allowed: true, whereClause: result };
}

export function isAuthenticated(ctx: RuleContext): boolean {
  return ctx.auth !== null;
}

export function isAdmin(ctx: RuleContext): boolean {
  return ctx.auth?.role === "admin";
}
