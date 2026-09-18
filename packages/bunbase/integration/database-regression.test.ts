import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq, getTableName, type SQL } from "drizzle-orm";
import { createBunBaseClient } from "../src/client.ts";
import { runUserMigrations } from "../src/core/database.ts";
import { type BunBaseServer, createServer } from "../src/core/server.ts";
import { regressionSchema } from "./fixtures/database-schema.ts";

const library = resolve(import.meta.dir, "..");
const instant = new Date("2026-09-15T12:34:56.789Z");
const metadata = { tags: ["café", "a/b", ""], nested: { enabled: false }, count: 0 };

for (const driver of ["sqlite", "postgres"] as const) {
  describe.skipIf(driver === "postgres" && !process.env.BUNBASE_TEST_POSTGRES_URL)(
    `${driver}: database and consumer regressions`,
    () => {
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const { schema, relations } = regressionSchema(driver, suffix);
      const { items, owners } = schema;
      let work: string;
      let bunbase: BunBaseServer;
      let server: ReturnType<BunBaseServer["listen"]>;
      let client: ReturnType<typeof createBunBaseClient<typeof schema>>;
      // The production CRUD layer also dispatches the common query API across
      // dialects. Runtime assertions below check the decoded values, not a cast.
      let db: any;
      let ownerReadRule: boolean | SQL = true;

      function writeSchema(upgraded: boolean) {
        writeFileSync(
          join(work, "schema.ts"),
          `import { regressionSchema } from ${JSON.stringify(join(import.meta.dir, "fixtures/database-schema.ts"))};
export const { owners, items } = regressionSchema(${JSON.stringify(driver)}, ${JSON.stringify(suffix)}, ${upgraded}).schema;\n`,
        );
      }

      async function generate() {
        const child = Bun.spawn(
          [
            "bun",
            "run",
            "drizzle-kit",
            "generate",
            "--config",
            join(work, "drizzle.config.ts"),
            "--output",
            "json",
          ],
          { cwd: library, stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new Error(`Migration generation failed\n${stdout}\n${stderr}`);
        expect(JSON.parse(stdout).status).toBe("ok");
      }

      beforeAll(async () => {
        mkdirSync(join(library, ".cache"), { recursive: true });
        work = mkdtempSync(join(library, ".cache", `regression-${driver}-`));
        writeSchema(false);
        writeFileSync(
          join(work, "drizzle.config.ts"),
          `export default ${JSON.stringify({
            dialect: driver === "postgres" ? "postgresql" : "sqlite",
            schema: join(work, "schema.ts"),
            out: join(work, "drizzle"),
          })};\n`,
        );
        await generate();
        const serviceKey = `bb_sk_${suffix}`;
        bunbase = createServer({
          schema,
          relations,
          rules: {
            [getTableName(items)]: {
              list: () => true,
              get: () => true,
              create: () => true,
              update: () => true,
              delete: () => true,
            },
            [getTableName(owners)]: {
              list: () => ownerReadRule,
              get: () => true,
              create: () => false,
              update: () => false,
              delete: () => false,
            },
          },
          config: {
            database:
              driver === "sqlite"
                ? { driver, path: join(work, "test.sqlite") }
                : { driver, url: process.env.BUNBASE_TEST_POSTGRES_URL! },
            development: false,
            cors: { origins: ["http://localhost"] },
            serviceKey,
            migrationsPath: join(work, "drizzle"),
            storage: { driver: "local", localPath: join(work, "uploads") },
          },
        });
        server = bunbase.listen(0);
        client = createBunBaseClient({ url: String(server.url), schema, apiKey: serviceKey });
        // The first HTTP request waits for the actual server bootstrap/migrator.
        expect((await client.api.items.list()).data).toEqual([]);
        db = bunbase.db;
        await db.insert(owners).values({ id: "owner", name: "Alice" });
      }, 30_000);

      afterAll(async () => {
        server?.stop(true);
        try {
          if (bunbase && driver === "postgres") {
            for (const table of [items, owners]) {
              await bunbase.adapter.rawExecute(
                `DROP TABLE IF EXISTS ${bunbase.adapter.quoteIdentifier(getTableName(table))}`,
              );
            }
          }
        } finally {
          bunbase?.adapter.close();
          if (work) rmSync(work, { recursive: true, force: true });
        }
      });

      test("Drizzle round-trips timestamps, JSON, false, empty strings, and SQL null", async () => {
        const row = {
          id: "codec",
          title: "Codec",
          ownerId: "owner",
          active: false,
          metadata,
          happenedAt: instant,
          note: "",
        };
        expect(await db.insert(items).values(row).returning()).toEqual([row]);
        expect(await db.select().from(items).where(eq(items.id, row.id))).toEqual([row]);
        expect(
          await db.query.items.findFirst({ where: { id: row.id }, with: { owner: true } }),
        ).toEqual({
          ...row,
          owner: { id: "owner", name: "Alice" },
        });
        await db
          .update(items)
          .set({ metadata: null, happenedAt: null, ownerId: null, note: null, active: true })
          .where(eq(items.id, row.id));
        expect(
          await db.query.items.findFirst({ where: { id: row.id }, with: { owner: true } }),
        ).toEqual({
          ...row,
          metadata: null,
          happenedAt: null,
          ownerId: null,
          note: null,
          active: true,
          owner: null,
        });
      });

      test("SDK create/get/update/delete preserves JSON and nullable fields over HTTP", async () => {
        const row = {
          id: "consumer",
          title: "Consumer",
          active: false,
          metadata,
          note: "",
          ownerId: "owner",
          happenedAt: null,
        };
        expect<unknown>(await client.api.items.create(row)).toEqual(row);
        expect<unknown>(await client.api.items.get(row.id, { expand: ["owner"] })).toEqual({
          ...row,
          owner: { id: "owner", name: "Alice" },
        });
        const changed = { ...row, active: true, metadata: null, note: null, ownerId: null };
        expect<unknown>(await client.api.items.update(row.id, changed)).toEqual(changed);
        expect<unknown>(await client.api.items.get(row.id, { expand: ["owner"] })).toEqual({
          ...changed,
          owner: null,
        });
        expect<unknown>(await client.api.items.delete(row.id)).toEqual({ deleted: true });
        expect<unknown>(await client.api.items.get(row.id)).toBeNull();
        expect<unknown>(await client.api.items.update(row.id, { title: "Missing" })).toBeNull();
        expect<unknown>(await client.api.items.delete(row.id)).toEqual({ deleted: false });
      });

      for (const sort of ["title", "happenedAt"] as const) {
        test(`SDK pagination preserves ${sort} ties, filtering, and optional relations`, async () => {
          const group = `page-${sort}`;
          const rows = Array.from({ length: 207 }, (_, i) => ({
            id: `${group}-${String(i).padStart(3, "0")}`,
            title: `Title ${String(Math.floor(i / 3)).padStart(3, "0")}`,
            ownerId: i % 2 === 0 ? "owner" : null,
            active: i < 205,
            metadata,
            happenedAt: new Date(instant.getTime() + Math.floor(i / 3) * 1000),
            note: group,
          }));
          await db.insert(items).values(rows);
          for (const order of ["asc", "desc"] as const) {
            const result = await client.api.items.listAll({
              filter: { note: group, active: true },
              sort,
              order,
              expand: ["owner"],
            });
            const expected = rows.slice(0, 205);
            if (order === "desc") expected.reverse();
            expect(result).toHaveLength(expected.length);
            for (let i = 0; i < expected.length; i++) {
              const row = expected[i]!;
              expect<unknown>(result[i]).toEqual({
                ...row,
                happenedAt: row.happenedAt.toISOString(),
                owner: row.ownerId ? { id: "owner", name: "Alice" } : null,
              });
            }
          }
        });
      }

      test("SDK to-many expansion decodes timestamps and JSON, including empty relations", async () => {
        await db.insert(owners).values([
          { id: "parent", name: "Parent" },
          { id: "empty", name: "Empty" },
        ]);
        const row = {
          id: "child",
          title: "Child",
          ownerId: "parent",
          active: false,
          metadata,
          happenedAt: instant,
          note: null,
        };
        await db.insert(items).values(row);
        expect<unknown>(await client.api.owners.get("parent", { expand: ["items"] })).toEqual({
          id: "parent",
          name: "Parent",
          items: [{ ...row, happenedAt: instant.toISOString() }],
        });
        expect<unknown>(await client.api.owners.get("empty", { expand: ["items"] })).toEqual({
          id: "empty",
          name: "Empty",
          items: [],
        });
      });

      test("SQL table rules still block denied and row-filtered expansions with aliased schemas", async () => {
        const row = {
          id: "restricted",
          title: "Restricted",
          ownerId: "owner",
          active: false,
          metadata: null,
          happenedAt: null,
          note: null,
        };
        await db.insert(items).values(row);
        try {
          for (const rule of [false, eq(owners.id, "someone-else")]) {
            ownerReadRule = rule;
            expect<unknown>(await client.api.items.get(row.id, { expand: ["owner"] })).toEqual(row);
            expect<unknown>(
              (await client.api.items.list({ filter: { id: row.id }, expand: ["owner"] })).data,
            ).toEqual([row]);
          }
        } finally {
          ownerReadRule = true;
        }
      });

      test("generated schema upgrade preserves existing rows and can be applied twice", async () => {
        const row = {
          id: "upgrade",
          title: "Keep me",
          active: false,
          metadata,
          happenedAt: instant,
          ownerId: "owner",
          note: null,
        };
        await db.insert(items).values(row);
        const before = await db.select().from(items).orderBy(items.id);
        writeSchema(true);
        await generate();
        await runUserMigrations(bunbase.db, bunbase.config);
        await runUserMigrations(bunbase.db, bunbase.config);
        expect(await db.select().from(items).where(eq(items.id, row.id))).toEqual([row]);
        expect(await db.select().from(items).orderBy(items.id)).toEqual(before);
        const upgraded = regressionSchema(driver, suffix, true).schema;
        expect(await db.select().from(upgraded.items).where(eq(upgraded.items.id, row.id))).toEqual(
          [{ ...row, upgradeNote: "pending" }],
        );
      }, 30_000);
    },
  );
}
