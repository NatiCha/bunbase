import type { AuthUser } from "../api/types.ts";

export type BeforeCreateContext = {
  data: Record<string, unknown>;
  auth: AuthUser | null;
  tableName: string;
};

export type AfterCreateContext = {
  record: Record<string, unknown>;
  auth: AuthUser | null;
  tableName: string;
};

export type BeforeUpdateContext = {
  id: string;
  data: Record<string, unknown>;
  existing: Record<string, unknown>;
  auth: AuthUser | null;
  tableName: string;
};

export type AfterUpdateContext = {
  id: string;
  record: Record<string, unknown>;
  auth: AuthUser | null;
  tableName: string;
};

export type BeforeDeleteContext = {
  id: string;
  record: Record<string, unknown>;
  auth: AuthUser | null;
  tableName: string;
};

export type AfterDeleteContext = {
  id: string;
  record: Record<string, unknown>;
  auth: AuthUser | null;
  tableName: string;
};

export type BeforeCreateFn = (
  ctx: BeforeCreateContext,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export type AfterCreateFn = (
  ctx: AfterCreateContext,
) => void | Promise<void>;

export type BeforeUpdateFn = (
  ctx: BeforeUpdateContext,
) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>;

export type AfterUpdateFn = (
  ctx: AfterUpdateContext,
) => void | Promise<void>;

export type BeforeDeleteFn = (
  ctx: BeforeDeleteContext,
) => void | Promise<void>;

export type AfterDeleteFn = (
  ctx: AfterDeleteContext,
) => void | Promise<void>;

export interface TableHooks {
  beforeCreate?: BeforeCreateFn;
  afterCreate?: AfterCreateFn;
  beforeUpdate?: BeforeUpdateFn;
  afterUpdate?: AfterUpdateFn;
  beforeDelete?: BeforeDeleteFn;
  afterDelete?: AfterDeleteFn;
}

export type Hooks = Record<string, TableHooks>;

export function defineHooks(hooks: Hooks): Hooks {
  return hooks;
}
