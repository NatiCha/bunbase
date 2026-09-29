import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { BunMySqlDatabase } from "drizzle-orm/bun-sql/mysql";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { mysqlTable, varchar as mysqlVarchar } from "drizzle-orm/mysql-core";
import { pgTable, varchar as pgVarchar } from "drizzle-orm/pg-core";
import { resolveConfig } from "../src/core/config.ts";
import { createDatabase, runUserMigrations } from "../src/core/database.ts";
import { createDiagnostics, migrationCheck } from "../src/core/diagnostics.ts";

// These URLs must identify disposable test databases, never production databases.
for (const driver of ["postgres", "mysql"] as const) {
  const url =
    process.env[driver === "postgres" ? "BUNBASE_TEST_POSTGRES_URL" : "BUNBASE_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `${driver}: generated migrations, bootstrap, and Drizzle CRUD`,
    async () => {
      const library = resolve(import.meta.dir, "..");
      const cache = join(library, ".cache");
      mkdirSync(cache, { recursive: true });
      const work = mkdtempSync(join(cache, `${driver}-`));
      const name = `upgrade_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const dialect = driver === "postgres" ? "postgresql" : "mysql";
      const tableBuilder = driver === "postgres" ? "pgTable" : "mysqlTable";
      await Bun.write(
        join(work, "schema.ts"),
        `import { ${tableBuilder}, varchar } from "drizzle-orm/${driver === "postgres" ? "pg" : "mysql"}-core";
export const items = ${tableBuilder}(${JSON.stringify(name)}, {
  id: varchar("id", { length: 80 }).primaryKey(),
  label: varchar("label", { length: 80 }).notNull(),
});\n`,
      );
      const migrationsPath = join(work, "drizzle");
      const configPath = join(work, "drizzle.config.ts");
      await Bun.write(
        configPath,
        `export default ${JSON.stringify({ dialect, schema: join(work, "schema.ts"), out: migrationsPath })};\n`,
      );
      const generate = Bun.spawn(
        ["bun", "run", "drizzle-kit", "generate", "--config", configPath],
        {
          cwd: library,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(generate.stdout).text(),
        new Response(generate.stderr).text(),
        generate.exited,
      ]);
      if (code !== 0) throw new Error(`Migration generation failed\n${stdout}\n${stderr}`);
      const config = resolveConfig({
        database: { driver, url: url! },
        development: false,
        cors: { origins: ["http://localhost"] },
        migrationsPath,
      });
      const { db, adapter } = createDatabase(config);
      try {
        await adapter.bootstrapInternalTables();
        await adapter.bootstrapInternalTables(); // Upgrades must tolerate existing internal tables.
        await runUserMigrations(db, config);
        await runUserMigrations(db, config); // Applied migrations must be idempotent.
        // Journal queries and readiness probes use the same adapter on both external engines.
        const migrations = await migrationCheck(adapter, migrationsPath);
        expect(migrations.message).toContain("0 pending, 0 changed");
        expect((await createDiagnostics(adapter, config, () => "ready").readiness()).status).toBe(
          "ready",
        );
        if (driver === "postgres") {
          const items = pgTable(name, {
            id: pgVarchar("id", { length: 80 }).primaryKey(),
            label: pgVarchar("label", { length: 80 }).notNull(),
          });
          const pg = db as BunSQLDatabase;
          await pg.insert(items).values({ id: "one", label: "before" });
          await pg.update(items).set({ label: "after" }).where(eq(items.id, "one"));
          expect(await pg.select().from(items)).toEqual([{ id: "one", label: "after" }]);
          await pg.delete(items).where(eq(items.id, "one"));
          expect(await pg.select().from(items)).toEqual([]);
        } else {
          const items = mysqlTable(name, {
            id: mysqlVarchar("id", { length: 80 }).primaryKey(),
            label: mysqlVarchar("label", { length: 80 }).notNull(),
          });
          const mysql = db as BunMySqlDatabase;
          await mysql.insert(items).values({ id: "one", label: "before" });
          await mysql.update(items).set({ label: "after" }).where(eq(items.id, "one"));
          expect(await mysql.select().from(items)).toEqual([{ id: "one", label: "after" }]);
          await mysql.delete(items).where(eq(items.id, "one"));
          expect(await mysql.select().from(items)).toEqual([]);

          // Exercise the database defaults themselves, not Drizzle's client-side
          // defaults. MySQL requires expression syntax for TEXT defaults.
          const inviteId = `invite_${name}`;
          try {
            await adapter.rawExecute(
              `INSERT INTO \`_invites\` (id, token_hash, invited_by, expires_at)
               VALUES ('${inviteId}', 'test-token', 'test-user', 2000000000)`,
            );
            await adapter.rawExecute(
              `INSERT INTO \`_organization_invites\` (id, org_id, email, token_hash, invited_by, expires_at)
               VALUES ('${inviteId}', 'test-org', 'test@example.com', 'test-token', 'test-user', 2000000000)`,
            );
            expect(
              await adapter.rawQuery(`SELECT role FROM \`_invites\` WHERE id = '${inviteId}'`),
            ).toEqual([{ role: "user" }]);
            expect(
              await adapter.rawQuery(
                `SELECT role FROM \`_organization_invites\` WHERE id = '${inviteId}'`,
              ),
            ).toEqual([{ role: "member" }]);
          } finally {
            await adapter.rawExecute(
              `DELETE FROM \`_organization_invites\` WHERE id = '${inviteId}'`,
            );
            await adapter.rawExecute(`DELETE FROM \`_invites\` WHERE id = '${inviteId}'`);
          }
        }
      } finally {
        try {
          await adapter.rawExecute(`DROP TABLE IF EXISTS ${adapter.quoteIdentifier(name)}`);
        } finally {
          adapter.close();
          rmSync(work, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
}
