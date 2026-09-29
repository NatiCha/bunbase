import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createServer } from "../core/server.ts";
import { defineHooks } from "../hooks/types.ts";
import { defineRules } from "../rules/types.ts";
import { createTestServer } from "../testing/index.ts";

const entries = sqliteTable("workspace_entries", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const rules = {
  workspace_entries: defineRules(entries, { get: ({ record }) => record?.title === "visible" }),
};
const hooks = {
  workspace_entries: defineHooks(entries, {
    afterCreate: ({ record }) => {
      const title: string = record.title;
      return void title;
    },
  }),
};

// Compile-only regressions: typed helpers must pass through both public factories,
// even when the schema export differs from its SQL table name.
export function typedFactories() {
  const schema = { entries };
  createServer({ schema, rules, hooks });
  void createTestServer({ schema, rules, hooks });
}
