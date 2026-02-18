// Relations support for CRUD queries
// Uses Drizzle's defineRelations() v2 API for auto-joining
// This module re-exports relation utilities for user schema definitions

export { defineRelations } from "drizzle-orm/relations";

// Max nesting depth for relational queries
export const MAX_RELATION_DEPTH = 3;

// Helper to build `with` clause for relational queries
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
