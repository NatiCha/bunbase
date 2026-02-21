/**
 * Relation helpers used by CRUD `expand` support.
 * @module
 */

export { defineRelations } from "drizzle-orm/relations";

/** Maximum allowed depth for dotted `expand` relation paths. */
export const MAX_RELATION_DEPTH = 3;

/**
 * Build a Drizzle `with` relation map from requested expand keys.
 *
 * @param requestedRelations Expand keys from query string, e.g. `["owner", "project.team"]`.
 * @param maxDepth Maximum dotted depth allowed. Defaults to `MAX_RELATION_DEPTH`.
 * @returns A `with` clause object, or `undefined` when no valid relation keys remain.
 */
export function buildWithClause(
  requestedRelations: string[] | undefined,
  maxDepth: number = MAX_RELATION_DEPTH,
): Record<string, true> | undefined {
  if (!requestedRelations || requestedRelations.length === 0) return undefined;

  const withClause: Record<string, true> = {};
  for (const rel of requestedRelations) {
    // Only allow relations up to max depth
    const depth = rel.split(".").length;
    if (depth <= maxDepth) {
      withClause[rel] = true;
    }
  }

  return Object.keys(withClause).length > 0 ? withClause : undefined;
}
