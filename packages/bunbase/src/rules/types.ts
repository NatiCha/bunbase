import type { SQL } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";
import type { AnyDb } from "../core/db-types.ts";

/**
 * Types for BunBase table access rules.
 * @module
 */

/**
 * Context passed to a rule function.
 *
 * @typeParam TRecord Existing record shape used by update/delete checks.
 * @typeParam TBody Request body shape used by create/update checks.
 * @typeParam TQuery Query-string shape.
 */
export type RuleArg<
  TRecord extends Record<string, unknown> = Record<string, unknown>,
  TBody extends Record<string, unknown> = Record<string, unknown>,
  TQuery extends Record<string, string> = Record<string, string>,
> = {
  auth: AuthUser | null;
  id?: string;                            // record id (get/update/delete)
  record?: TRecord;                       // existing record (update/delete)
  body: TBody;                            // request body (create/update), {} otherwise
  headers: Record<string, string>;        // lowercased header keys
  query: TQuery;                          // URL search params
  method: string;                         // GET, POST, PATCH, DELETE, SUBSCRIBE
  db: AnyDb;                              // for cross-table queries
};

/**
 * Rule return semantics:
 * - `true`: allow operation.
 * - `false`: deny operation.
 * - `null`: explicit allow — identical to `true` in the evaluator. Prefer `true` or `allowAll()`.
 *   @deprecated Use `true` instead of `null` for clarity. Both are treated identically.
 * - `SQL`: allow, but apply as a WHERE filter where supported.
 */
export type RuleResult = boolean | SQL | null;

/** Rule function type used for table operation checks. */
export type RuleFunction<TArg extends RuleArg = RuleArg> =
  (arg: TArg) => RuleResult | Promise<RuleResult>;

export interface TableRules {
  list?: RuleFunction;
  /**
   * @deprecated Use `get` instead. `view` is a legacy alias for single-record reads and will be removed in a future version.
   */
  view?: RuleFunction;
  get?: RuleFunction;
  create?: RuleFunction;
  update?: RuleFunction;
  delete?: RuleFunction;
}

export type Rules = Record<string, TableRules>;

/**
 * Define table rules.
 *
 * @remarks BunBase is deny-by-default. Missing operation rules are denied.
 */
export function defineRules(rules: Rules): Rules {
  return rules;
}
