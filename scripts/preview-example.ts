import { customRoutes } from "../examples/task-manager/src/custom-routes.ts";
import { fields } from "../examples/task-manager/src/fields.ts";
import html from "../examples/task-manager/src/frontend/index.html";
import { hooks } from "../examples/task-manager/src/hooks.ts";
import { rules } from "../examples/task-manager/src/rules.ts";
import * as schema from "../examples/task-manager/src/schema.ts";
import { createTestServer } from "../packages/bunbase/src/testing/index.ts";

// Exercise the real example UI and policies with a disposable SQLite database.
const server = await createTestServer({
  schema,
  relations: schema.relations,
  rules,
  hooks,
  fields,
  extend: customRoutes,
  config: { frontend: { html }, realtime: { enabled: true } },
});
console.log(`Example preview: ${server.baseUrl}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.cleanup();
    process.exit(0);
  });
}
