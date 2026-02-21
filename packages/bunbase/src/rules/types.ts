import type { SQL } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";
import type { AnyDb } from "../core/db-types.ts";

export type RuleArg = {
  auth: AuthUser | null;
  id?: string;                            // record id (get/update/delete)
  record?: Record<string, unknown>;       // existing record (update/delete)
  body: Record<string, unknown>;          // request body (create/update), {} otherwise
  headers: Record<string, string>;        // lowercased header keys
  query: Record<string, string>;          // URL search params
  method: string;                         // GET, POST, PATCH, DELETE, SUBSCRIBE
  db: AnyDb;                              // for cross-table queries
};

// A rule can return:
// - boolean: gate (allow/deny)
// - SQL: WHERE clause (for list filtering)
// - null: no restriction (allow all)
export type RuleResult = boolean | SQL | null;

export type RuleFunction = (arg: RuleArg) => RuleResult | Promise<RuleResult>;

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
