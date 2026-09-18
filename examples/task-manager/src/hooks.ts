/**
 * Example hooks: stamp server-controlled fields instead of trusting the client.
 *
 * The frontend no longer sends `ownerId` — the server fills it from the
 * authenticated user in a `beforeCreate` hook. This is the canonical pattern
 * for any "owned by the current user" column.
 *
 * (For full type inference on `data`, use the typed overload
 * `defineHooks(schema.projects, { ... })`.)
 */
import { defineHooks } from "@naticha/bunbase";

export const hooks = defineHooks({
  projects: {
    beforeCreate: ({ data, auth }) => ({ ...data, ownerId: auth?.id }),
  },
});
