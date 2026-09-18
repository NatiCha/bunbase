import type { Column, InferSelectModel, Table } from "drizzle-orm";

/**
 * Field-level access policy for CRUD tables.
 *
 * BunBase strips and protects columns at the data-access boundary so that
 * sensitive values never leak into responses, cursors, or realtime broadcasts,
 * and so that clients cannot mass-assign server-controlled columns.
 *
 * @module
 */

/**
 * Declarative per-table field policy.
 *
 * Field names may be given as the Drizzle schema property name (e.g. `passwordHash`)
 * or the underlying SQL column name (e.g. `password_hash`) — both are matched.
 */
export interface FieldPolicy {
  /**
   * Columns that must never be serialized to clients (HTTP bodies, pagination
   * cursors, or realtime broadcasts) and cannot be filtered or sorted on.
   * Hidden columns are also implicitly non-writable via CRUD.
   */
  hidden?: string[];
  /**
   * Columns that can never be written through CRUD create or update. Use this
   * for server-controlled columns (e.g. `role`, `plan`, `credits`) that should
   * only be set by hooks, the admin API, or auth flows.
   */
  readonly?: string[];
  /**
   * Columns that may be set on create but never changed on update. Defaults to
   * `id` and the conventional timestamp columns so a client cannot re-key a row
   * or backdate it via PATCH.
   */
  immutable?: string[];
}

export type FieldPolicyMap = Record<string, FieldPolicy>;

/** Typed field policy whose field names are constrained to the table's columns. */
export type FieldPolicyFor<TTable extends Table> = {
  hidden?: (keyof InferSelectModel<TTable> & string)[];
  readonly?: (keyof InferSelectModel<TTable> & string)[];
  immutable?: (keyof InferSelectModel<TTable> & string)[];
};

// Columns that are ALWAYS hidden and never writable, regardless of config.
// These are managed by BunBase's auth system and must never appear in any
// response or be settable by a client.
const ALWAYS_HIDDEN = ["passwordHash", "password_hash"];
// Columns that are immutable-on-update by default (still settable on create).
const DEFAULT_IMMUTABLE = ["id", "createdAt", "created_at", "updatedAt", "updated_at"];

/**
 * Define a typed field policy for a Drizzle table.
 *
 * @example
 * ```ts
 * fields: {
 *   users: defineFields(schema.users, {
 *     hidden: ["passwordHash", "mfaSecret"],
 *     readonly: ["role", "emailVerified"],
 *   }),
 * }
 * ```
 */
export function defineFields<TTable extends Table>(
  table: TTable,
  policy: FieldPolicyFor<TTable>,
): FieldPolicy;
/** Multi-table shorthand (untyped). */
export function defineFields(policies: FieldPolicyMap): FieldPolicyMap;
export function defineFields(
  tableOrPolicies: Table | FieldPolicyMap,
  policy?: FieldPolicy,
): FieldPolicy | FieldPolicyMap {
  if (policy !== undefined) return policy;
  return tableOrPolicies as FieldPolicyMap;
}

/**
 * A resolved policy for a single table, expressed in terms of Drizzle schema
 * property keys (the keys present on rows returned by `db.select()`).
 */
export interface ResolvedFieldPolicy {
  /** Schema-key set of columns that must never be serialized. */
  hidden: Set<string>;
  /** Schema-key set of columns that can never be written via CRUD. */
  readonly: Set<string>;
  /** Schema-key set of columns that cannot be changed on update. */
  immutable: Set<string>;
  /** True when `key` (a schema key) must not be serialized or queried. */
  isHidden(key: string): boolean;
  /** True when `key` may be written for the given phase. */
  isWritable(key: string, phase: "create" | "update"): boolean;
}

// Map a declared field name (schema key OR SQL column name) to its schema key(s).
function namesToKeys(columns: Record<string, Column>, names: string[]): string[] {
  const keys: string[] = [];
  for (const name of names) {
    if (name in columns) {
      keys.push(name);
      continue;
    }
    for (const [key, col] of Object.entries(columns)) {
      if (col.name === name) keys.push(key);
    }
  }
  return keys;
}

/**
 * Resolve a table's field policy against its columns, applying secure defaults.
 */
export function resolveFieldPolicy(
  columns: Record<string, Column>,
  policy?: FieldPolicy,
): ResolvedFieldPolicy {
  const hidden = new Set<string>([
    ...namesToKeys(columns, ALWAYS_HIDDEN),
    ...namesToKeys(columns, policy?.hidden ?? []),
  ]);
  const readonly = new Set<string>([
    // Hidden columns are implicitly non-writable.
    ...hidden,
    ...namesToKeys(columns, policy?.readonly ?? []),
  ]);
  const immutable = new Set<string>(namesToKeys(columns, policy?.immutable ?? DEFAULT_IMMUTABLE));

  return {
    hidden,
    readonly,
    immutable,
    isHidden: (key: string) => hidden.has(key),
    isWritable: (key: string, phase: "create" | "update") => {
      if (readonly.has(key)) return false;
      if (phase === "update" && immutable.has(key)) return false;
      return true;
    },
  };
}

/**
 * Recursively strip hidden fields from a record before serialization.
 *
 * `topLevelHidden` are the schema keys hidden on the primary table. The columns
 * in {@link ALWAYS_HIDDEN} (password hashes) are stripped at every depth so that
 * expanded/related rows can never leak a credential hash.
 */
export function stripHidden(
  row: Record<string, unknown>,
  topLevelHidden?: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (ALWAYS_HIDDEN.includes(key)) continue;
    if (topLevelHidden?.has(key)) continue;
    if (Array.isArray(val)) {
      result[key] = val.map((item) =>
        item !== null && typeof item === "object" && !(item instanceof Date)
          ? stripHidden(item as Record<string, unknown>)
          : item instanceof Date
            ? item.toISOString()
            : item,
      );
    } else if (val instanceof Date) {
      result[key] = val.toISOString();
    } else if (val !== null && typeof val === "object") {
      // Nested related object: strip ALWAYS_HIDDEN only (table identity unknown here).
      result[key] = stripHidden(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}
