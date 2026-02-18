import { defineRules, authenticated, ownerOnly } from "tsbase";
import { projects } from "./schema";

export const rules = defineRules({
  projects: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => ownerOnly(projects.ownerId as any, { auth }),
    delete: ({ auth }) => ownerOnly(projects.ownerId as any, { auth }),
  },
  tasks: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => authenticated({ auth }),
    delete: ({ auth }) => auth?.role === "admin",
  },
});
