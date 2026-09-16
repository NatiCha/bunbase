import { boolean, jsonb, pgTable, text as pgText, timestamp } from "drizzle-orm/pg-core";
import { defineRelations } from "drizzle-orm/relations";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type TestMetadata = { tags: string[]; nested: { enabled: boolean }; count: number };

// Used by both the running server and drizzle-kit, so migrations exercise the
// same schema as consumer queries. Names are unique within a disposable database.
export function regressionSchema(driver: "sqlite" | "postgres", suffix: string, upgraded = false) {
  if (driver === "postgres") {
    const owners = pgTable(`owners_${suffix}`, {
      id: pgText("id").primaryKey(),
      name: pgText("name").notNull(),
    });
    const items = pgTable(`items_${suffix}`, {
      id: pgText("id").primaryKey(),
      title: pgText("title").notNull(),
      ownerId: pgText("owner_id").references(() => owners.id),
      active: boolean("active").notNull(),
      metadata: jsonb("metadata").$type<TestMetadata>(),
      happenedAt: timestamp("happened_at", { withTimezone: true, precision: 3 }),
      note: pgText("note"),
      ...(upgraded ? { upgradeNote: pgText("upgrade_note").notNull().default("pending") } : {}),
    });
    const schema = { owners, items };
    return {
      schema,
      relations: defineRelations(schema, (r) => ({
        items: { owner: r.one.owners({ from: r.items.ownerId, to: r.owners.id }) },
        owners: { items: r.many.items({ from: r.owners.id, to: r.items.ownerId }) },
      })),
    };
  }
  const owners = sqliteTable(`owners_${suffix}`, {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
  });
  const items = sqliteTable(`items_${suffix}`, {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    ownerId: text("owner_id").references(() => owners.id),
    active: integer("active", { mode: "boolean" }).notNull(),
    metadata: text("metadata", { mode: "json" }).$type<TestMetadata>(),
    happenedAt: integer("happened_at", { mode: "timestamp_ms" }),
    note: text("note"),
    ...(upgraded ? { upgradeNote: text("upgrade_note").notNull().default("pending") } : {}),
  });
  const schema = { owners, items };
  return {
    schema,
    relations: defineRelations(schema, (r) => ({
      items: { owner: r.one.owners({ from: r.items.ownerId, to: r.owners.id }) },
      owners: { items: r.many.items({ from: r.owners.id, to: r.items.ownerId }) },
    })),
  };
}
