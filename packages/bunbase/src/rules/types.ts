import type { InferInsertModel, InferSelectModel, SQL, Table } from "drizzle-orm";
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
  id?: string; // record id (get/update/delete)
  record?: TRecord; // existing record (update/delete)
  body: TBody; // request body (create/update), {} otherwise
  headers: Record<string, string>; // lowercased header keys
  query: TQuery; // URL search params
  method: string; // GET, POST, PATCH, DELETE, SUBSCRIBE
  db: AnyDb; // for cross-table queries
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
export type RuleFunction<TArg extends RuleArg = RuleArg> = (
  arg: TArg,
) => RuleResult | Promise<RuleResult>;

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
 * Utility to build a typed TableRules contract from a Drizzle table.
 * `record` is typed as the table's select model; `body` as a partial insert model.
 */
export type TableRulesFor<TTable extends Table> = {
  list?: RuleFunction<
    RuleArg<
      InferSelectModel<TTable> & Record<string, unknown>,
      Partial<InferInsertModel<TTable>> & Record<string, unknown>
    >
  >;
  get?: RuleFunction<
    RuleArg<
      InferSelectModel<TTable> & Record<string, unknown>,
      Partial<InferInsertModel<TTable>> & Record<string, unknown>
    >
  >;
  create?: RuleFunction<
    RuleArg<
      InferSelectModel<TTable> & Record<string, unknown>,
      Partial<InferInsertModel<TTable>> & Record<string, unknown>
    >
  >;
  update?: RuleFunction<
    RuleArg<
      InferSelectModel<TTable> & Record<string, unknown>,
      Partial<InferInsertModel<TTable>> & Record<string, unknown>
    >
  >;
  delete?: RuleFunction<
    RuleArg<
      InferSelectModel<TTable> & Record<string, unknown>,
      Partial<InferInsertModel<TTable>> & Record<string, unknown>
    >
  >;
};

/**
 * Define rules for a single table with full type inference from the Drizzle table:
 *
 * ```ts
 * rules: {
 *   posts: defineRules(schema.posts, {
 *     update({ record, auth }) {
 *       // record is typed as Post ✓
 *       return record.authorId === auth?.id;
 *     },
 *   }),
 * }
 * ```
 */
export function defineRules<TTable extends Table>(
  table: TTable,
  rules: TableRulesFor<TTable>,
): TableRulesFor<TTable>;
/**
 * Define rules for multiple tables at once (untyped records):
 *
 * ```ts
 * rules: defineRules({
 *   posts: { list: () => true },
 * })
 * ```
 *
 * @remarks BunBase is deny-by-default. Missing operation rules are denied.
 */
export function defineRules(rules: Rules): Rules;
export function defineRules<TTable extends Table>(
  tableOrRules: TTable | Rules,
  rules?: TableRulesFor<TTable>,
): TableRulesFor<TTable> | Rules {
  if (rules !== undefined) return rules;
  return tableOrRules as Rules;
}
