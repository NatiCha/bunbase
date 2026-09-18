/**
 * Example field policy.
 *
 * `passwordHash` is always hidden and `id`/timestamps are immutable by default,
 * so the only thing we add here is making the privileged `role` and
 * `emailVerified` columns read-only — they can never be set via the public CRUD
 * API (only by auth flows, hooks, or the admin API). Without this, a user who
 * can update their own row could mass-assign `role: "admin"`.
 *
 * (For column-name autocomplete, use the typed overload
 * `defineFields(schema.users, { ... })`.)
 */
import { defineFields } from "@naticha/bunbase";

export const fields = defineFields({
  projects: { readonly: ["ownerId"] },
  users: { readonly: ["role", "emailVerified"] },
});
