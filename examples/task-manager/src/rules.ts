/**
 * Example rules showing public read access plus authenticated/owner/admin mutations.
 */
import { authenticated, defineRules, ownerOnly } from "bunbase";
import { projects } from "./schema";

export const rules = defineRules({
  projects: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(projects.ownerId as any, auth),
    delete: ({ auth }) => ownerOnly(projects.ownerId as any, auth),
  },
  tasks: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => authenticated(auth),
    delete: ({ auth }) => auth?.role === "admin",
  },
});
