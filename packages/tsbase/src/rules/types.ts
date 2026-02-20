import type { SQL } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";

export type RuleContext = {
  auth: AuthUser | null;
  id?: string; // record id for get/update/delete
};

// A rule can return:
// - boolean: gate (allow/deny)
// - SQL: WHERE clause (for list filtering)
// - null: no restriction (allow all)
export type RuleResult = boolean | SQL | null;

export type RuleFunction = (ctx: RuleContext) => RuleResult | Promise<RuleResult>;

export interface TableRules {
  list?: RuleFunction;
  view?: RuleFunction;
  get?: RuleFunction;
  create?: RuleFunction;
  update?: RuleFunction;
  delete?: RuleFunction;
}

export type Rules = Record<string, TableRules>;

export function defineRules(rules: Rules): Rules {
  return rules;
}
