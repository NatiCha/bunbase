import { expectTypeOf, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createBunBaseClient } from "../client.ts";
import { createBunBaseReact } from "../react/index.tsx";

const projects = sqliteTable("projects", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => Bun.randomUUIDv7()),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
});
const schema = { projects };

test("server-assigned columns are omitted from SDK and React write inputs", () => {
  const options = {
    url: "http://localhost",
    schema,
    serverFields: { projects: ["ownerId"] },
  } as const;
  const client = createBunBaseClient(options);
  const react = createBunBaseReact(options);
  type Input = Omit<typeof projects.$inferInsert, "ownerId">;
  expectTypeOf<Parameters<typeof client.api.projects.create>[0]>().toEqualTypeOf<Input>();
  expectTypeOf<
    Parameters<ReturnType<typeof react.api.projects.create.mutationOptions>["mutationFn"]>[0]
  >().toEqualTypeOf<Input>();
  expectTypeOf<Parameters<typeof client.api.projects.update>[1]>().toEqualTypeOf<Partial<Input>>();
  expectTypeOf<Awaited<ReturnType<typeof client.api.projects.create>>>().toEqualTypeOf<
    typeof projects.$inferSelect
  >();
});

test("clients without serverFields retain all required insert columns", () => {
  const client = createBunBaseClient({ url: "http://localhost", schema });
  expectTypeOf<Parameters<typeof client.api.projects.create>[0]>().toEqualTypeOf<
    typeof projects.$inferInsert
  >();
  // @ts-expect-error serverFields only accepts columns present in the schema.
  createBunBaseClient({ url: "http://localhost", schema, serverFields: { projects: ["missing"] } });
});
