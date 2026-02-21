import type { SQL } from "drizzle-orm";
import type { RuleFunction, RuleResult, RuleArg } from "./types.ts";

export interface EvaluatedRule {
  allowed: boolean;
  whereClause?: SQL;
}

export async function evaluateRule(
  rule: RuleFunction | undefined,
  arg: RuleArg,
): Promise<EvaluatedRule> {
  if (!rule) {
    // No rule defined = deny by default
    return { allowed: false };
  }

  const result: RuleResult = await rule(arg);

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

export function isAuthenticated(arg: RuleArg): boolean {
  return arg.auth !== null;
}

export function isAdmin(arg: RuleArg): boolean {
  return arg.auth?.role === "admin";
}
