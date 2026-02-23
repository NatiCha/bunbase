import type { InferInsertModel, InferSelectModel, Table } from "drizzle-orm";
import type { AuthUser } from "../api/types.ts";

/**
 * CRUD lifecycle hooks for BunBase table handlers.
 * @module
 */

/** Minimal request context passed to every hook. */
export interface HookRequest {
  method: string;
  path: string;
  /** Client IP from X-Forwarded-For / X-Real-IP headers, or null if unavailable. */
  ip: string | null;
  headers: Headers;
}

export type BeforeCreateContext<TInsert extends Record<string, unknown> = Record<string, unknown>> =
  {
    data: TInsert;
    auth: AuthUser | null;
    tableName: string;
    request: HookRequest;
  };

export type AfterCreateContext<TSelect extends Record<string, unknown> = Record<string, unknown>> =
  {
    record: TSelect;
    auth: AuthUser | null;
    tableName: string;
    request: HookRequest;
  };

export type BeforeUpdateContext<
  TInsert extends Record<string, unknown> = Record<string, unknown>,
  TSelect extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: string;
  data: Partial<TInsert>;
  existing: TSelect;
  auth: AuthUser | null;
  tableName: string;
  request: HookRequest;
};

export type AfterUpdateContext<TSelect extends Record<string, unknown> = Record<string, unknown>> =
  {
    id: string;
    record: TSelect;
    auth: AuthUser | null;
    tableName: string;
    request: HookRequest;
  };

export type BeforeDeleteContext<TSelect extends Record<string, unknown> = Record<string, unknown>> =
  {
    id: string;
    record: TSelect;
    auth: AuthUser | null;
    tableName: string;
    request: HookRequest;
  };

export type AfterDeleteContext<TSelect extends Record<string, unknown> = Record<string, unknown>> =
  {
    id: string;
    record: TSelect;
    auth: AuthUser | null;
    tableName: string;
    request: HookRequest;
  };

export type BeforeCreateFn<TInsert extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: BeforeCreateContext<TInsert>,
  // biome-ignore lint/suspicious/noConfusingVoidType: void needed for async hooks that return nothing
) => TInsert | undefined | void | Promise<TInsert | undefined | void>;

export type AfterCreateFn<TSelect extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: AfterCreateContext<TSelect>,
) => void | Promise<void>;

export type BeforeUpdateFn<
  TInsert extends Record<string, unknown> = Record<string, unknown>,
  TSelect extends Record<string, unknown> = Record<string, unknown>,
> = (
  ctx: BeforeUpdateContext<TInsert, TSelect>,
  // biome-ignore lint/suspicious/noConfusingVoidType: void needed for async hooks that return nothing
) => Partial<TInsert> | undefined | void | Promise<Partial<TInsert> | undefined | void>;

export type AfterUpdateFn<TSelect extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: AfterUpdateContext<TSelect>,
) => void | Promise<void>;

export type BeforeDeleteFn<TSelect extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: BeforeDeleteContext<TSelect>,
) => void | Promise<void>;

export type AfterDeleteFn<TSelect extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: AfterDeleteContext<TSelect>,
) => void | Promise<void>;

export interface TableHooks<
  TInsert extends Record<string, unknown> = Record<string, unknown>,
  TSelect extends Record<string, unknown> = Record<string, unknown>,
> {
  beforeCreate?: BeforeCreateFn<TInsert>;
  afterCreate?: AfterCreateFn<TSelect>;
  beforeUpdate?: BeforeUpdateFn<TInsert, TSelect>;
  afterUpdate?: AfterUpdateFn<TSelect>;
  beforeDelete?: BeforeDeleteFn<TSelect>;
  afterDelete?: AfterDeleteFn<TSelect>;
}

export type Hooks = Record<string, TableHooks>;

/**
 * Define hooks for a single table with full type inference from the Drizzle table:
 *
 * ```ts
 * hooks: {
 *   posts: defineHooks(schema.posts, {
 *     afterCreate({ record, auth, request }) {
 *       // record is typed as Post ✓
 *     },
 *   }),
 * }
 * ```
 */
export function defineHooks<TTable extends Table>(
  table: TTable,
  hooks: TableHooksFor<TTable>,
): TableHooksFor<TTable>;
/**
 * Define hooks for multiple tables at once (untyped records):
 *
 * ```ts
 * hooks: defineHooks({
 *   posts: { afterCreate({ record }) { ... } },
 * })
 * ```
 */
export function defineHooks(hooks: Hooks): Hooks;
export function defineHooks<TTable extends Table>(
  tableOrHooks: TTable | Hooks,
  hooks?: TableHooksFor<TTable>,
): TableHooksFor<TTable> | Hooks {
  if (hooks !== undefined) {
    return hooks;
  }
  return tableOrHooks as Hooks;
}

/**
 * Utility to build a typed TableHooks contract from a Drizzle table.
 */
export type TableHooksFor<TTable extends Table> = TableHooks<
  InferInsertModel<TTable> & Record<string, unknown>,
  InferSelectModel<TTable> & Record<string, unknown>
>;
