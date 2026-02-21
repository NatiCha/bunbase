import type { AuthUser } from "../api/types.ts";
import type { InferInsertModel, InferSelectModel, Table } from "drizzle-orm";

/**
 * CRUD lifecycle hooks for BunBase table handlers.
 * @module
 */

export type BeforeCreateContext<TInsert extends Record<string, unknown> = Record<string, unknown>> = {
  data: TInsert;
  auth: AuthUser | null;
  tableName: string;
};

export type AfterCreateContext<TSelect extends Record<string, unknown> = Record<string, unknown>> = {
  record: TSelect;
  auth: AuthUser | null;
  tableName: string;
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
};

export type AfterUpdateContext<TSelect extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  record: TSelect;
  auth: AuthUser | null;
  tableName: string;
};

export type BeforeDeleteContext<TSelect extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  record: TSelect;
  auth: AuthUser | null;
  tableName: string;
};

export type AfterDeleteContext<TSelect extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  record: TSelect;
  auth: AuthUser | null;
  tableName: string;
};

export type BeforeCreateFn<TInsert extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: BeforeCreateContext<TInsert>,
) => TInsert | void | Promise<TInsert | void>;

export type AfterCreateFn<TSelect extends Record<string, unknown> = Record<string, unknown>> = (
  ctx: AfterCreateContext<TSelect>,
) => void | Promise<void>;

export type BeforeUpdateFn<
  TInsert extends Record<string, unknown> = Record<string, unknown>,
  TSelect extends Record<string, unknown> = Record<string, unknown>,
> = (
  ctx: BeforeUpdateContext<TInsert, TSelect>,
) => Partial<TInsert> | void | Promise<Partial<TInsert> | void>;

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

export function defineHooks(hooks: Hooks): Hooks {
  return hooks;
}

/**
 * Utility to build a typed TableHooks contract from a Drizzle table.
 */
export type TableHooksFor<TTable extends Table> = TableHooks<
  InferInsertModel<TTable> & Record<string, unknown>,
  InferSelectModel<TTable> & Record<string, unknown>
>;
