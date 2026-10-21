---
title: Upgrading to 0.2
---

BunBase 0.2 adds a team-workspace starter, production readiness/diagnostics, and
verified offline SQLite backups. Existing applications can adopt the operations
features without switching templates. Keep the matched Drizzle pins from your
current BunBase 0.1 project; this release does not change their versions.

1. Update `@naticha/bunbase` to `0.2.0`, install with Bun, and run your type checks
   and application tests.
2. Move any custom `/ready` route. It is now reserved for the built-in readiness
   endpoint. Point your deployment health check at `/ready`; keep `/health` for
   process liveness.
3. Review file upload rules. They still use the collection's `create` rule, but
   now receive the parent `id` and `record`, and returned SQL predicates must match
   that record. Applications previously relying on ignored upload predicates may
   now receive `403`; update the rule to express the intended access.
4. Run `bunx bunbase doctor` with a service key against the running server. Resolve
   failing checks, including missing or changed migration history. Diagnostics
   inspect only; they never repair or apply migrations.
5. Rehearse recovery before upgrading production data. Follow [operations](/operations/)
   for the offline SQLite workflow or your database provider's native tools.

Typed `defineRules(table, ...)` and `defineHooks(table, ...)` maps now pass directly
to `createServer` and `createTestServer` under strict TypeScript. Keys correspond to
SQL table names, including when schema exports use different names. Legacy untyped
maps remain supported.

The new starter is created with `--template team-workspace`; it does not modify an
existing project. `--template` and `--database` flags are supported by both CLI
entry points. Unknown options are rejected rather than silently ignored.
