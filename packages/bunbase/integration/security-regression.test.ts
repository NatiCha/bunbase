import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { mysqlTable, varchar as mysqlVarchar } from "drizzle-orm/mysql-core";
import { pgTable, varchar as pgVarchar } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { encrypt } from "../src/auth/encryption.ts";
import { validateAndConsumeInvite } from "../src/auth/invitations.ts";
import { consumeRefreshJwt, signJwt, verifyJwt } from "../src/auth/jwt/core.ts";
import { storeBackupCodes, verifyBackupCode } from "../src/auth/mfa/index.ts";
import { createTotpRoutes } from "../src/auth/mfa/totp.ts";
import { generateSecret, generateTotpCode } from "../src/auth/mfa/totp-core.ts";
import { transferOwnership } from "../src/auth/organizations/transfer.ts";
import { createSession } from "../src/auth/sessions.ts";
import { hashToken } from "../src/auth/tokens.ts";
import type { DatabaseAdapter } from "../src/core/adapter.ts";
import { resolveConfig } from "../src/core/config.ts";
import { createDatabase } from "../src/core/database.ts";
import { getInternalSchema } from "../src/core/internal-schema.ts";
import { orgAdmin, orgMember, orgOwner } from "../src/rules/helpers.ts";

for (const driver of ["sqlite", "postgres", "mysql"] as const) {
  const url =
    process.env[driver === "postgres" ? "BUNBASE_TEST_POSTGRES_URL" : "BUNBASE_TEST_MYSQL_URL"];
  describe.skipIf(driver !== "sqlite" && !url)(`${driver}: atomic security operations`, () => {
    const userId = Bun.randomUUIDv7();
    const tableName = `security_users_${userId.replaceAll("-", "")}`;
    const users =
      driver === "sqlite"
        ? sqliteTable(tableName, {
            id: text("id").primaryKey(),
            email: text("email"),
            role: text("role"),
          })
        : driver === "postgres"
          ? pgTable(tableName, {
              id: pgVarchar("id", { length: 80 }).primaryKey(),
              email: pgVarchar("email", { length: 255 }),
              role: pgVarchar("role", { length: 30 }),
            })
          : mysqlTable(tableName, {
              id: mysqlVarchar("id", { length: 80 }).primaryKey(),
              email: mysqlVarchar("email", { length: 255 }),
              role: mysqlVarchar("role", { length: 30 }),
            });
    const schema = getInternalSchema(driver);
    const orgIds: string[] = [];
    const jwtIds: string[] = [];
    let db: any;
    let adapter: DatabaseAdapter;
    let work: string;
    const encryptionKey = "atomic-security-tests";
    let config: ReturnType<typeof resolveConfig>;

    beforeAll(async () => {
      work = mkdtempSync(join(tmpdir(), "bunbase-security-"));
      config = resolveConfig({
        database:
          driver === "sqlite" ? { driver, path: join(work, "test.sqlite") } : { driver, url: url! },
        development: false,
        cors: { origins: ["http://localhost"] },
        auth: { rateLimit: { max: 10000 }, mfa: { totp: { enabled: true }, encryptionKey } },
      });
      ({ db, adapter } = createDatabase(config));
      await adapter.bootstrapInternalTables();
      await adapter.rawExecute(
        `CREATE TABLE ${adapter.quoteIdentifier(tableName)} (id VARCHAR(80) PRIMARY KEY, email VARCHAR(255), role VARCHAR(30))`,
      );
      await db.insert(users).values({ id: userId, email: "atomic@example.com", role: "user" });
    });
    afterAll(async () => {
      try {
        if (db) {
          if (jwtIds.length)
            await db
              .delete(schema.jwtRevocations)
              .where(inArray(schema.jwtRevocations.jti, jwtIds));
          for (const table of [schema.sessions, schema.mfaTotp, schema.mfaBackupCodes])
            await db.delete(table).where(eq(table.userId, userId));
          await db.delete(schema.invites).where(eq(schema.invites.invitedBy, userId));
          if (orgIds.length) {
            await db
              .delete(schema.organizationMembers)
              .where(inArray(schema.organizationMembers.orgId, orgIds));
            await db.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
          }
          await adapter.rawExecute(`DROP TABLE IF EXISTS ${adapter.quoteIdentifier(tableName)}`);
        }
      } finally {
        adapter?.close();
        if (work) rmSync(work, { recursive: true, force: true });
      }
    });

    test("concurrent refresh claims are single-use and revoke the token family", async () => {
      const secret = "dialect-refresh-test";
      const refresh = await signJwt(
        { sub: userId, email: "atomic@example.com", role: "user", type: "refresh" },
        secret,
        3600,
      );
      const payload = (await verifyJwt(refresh, secret))!;
      jwtIds.push(payload.jti, `family:${createHash("sha256").update(payload.fid).digest("hex")}`);
      const access = await signJwt({ ...payload, type: "access" }, secret, 900);
      const results = await Promise.all([
        consumeRefreshJwt(db, schema, payload),
        consumeRefreshJwt(db, schema, payload),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await verifyJwt(access, secret, db, schema)).toBeNull();
      expect(await verifyJwt(refresh, secret, db, schema)).toBeNull();
      const unrelated = await signJwt(
        { sub: userId, email: "atomic@example.com", role: "user", type: "access" },
        secret,
        900,
      );
      expect(await verifyJwt(unrelated, secret, db, schema)).not.toBeNull();
    });

    for (const uses of [1, 3, 0]) {
      test(`concurrent invite claims respect maxUses=${uses}`, async () => {
        const token = Bun.randomUUIDv7();
        const id = Bun.randomUUIDv7();
        await db.insert(schema.invites).values({
          id,
          tokenHash: await hashToken(token),
          role: "user",
          invitedBy: userId,
          maxUses: uses,
          useCount: 0,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          createdAt: new Date().toISOString(),
        });
        // Force a legal interleaving where all contenders read the same initial
        // state. Real database writes decide the winners; only reads are gated.
        let readers = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const concurrentDb = new Proxy(db, {
          get(target, prop) {
            if (prop !== "select") {
              const value = Reflect.get(target, prop);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...args: unknown[]) => {
              const query = target.select(...args);
              if (args.length) return query;
              return {
                from(table: unknown) {
                  return {
                    async where(condition: unknown) {
                      const rows = await query.from(table).where(condition);
                      if (++readers === 8) release();
                      await barrier;
                      return rows;
                    },
                  };
                },
              };
            };
          },
        });
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            validateAndConsumeInvite(concurrentDb, schema, token, `claim${i}@example.com`),
          ),
        );
        const expected = uses === 0 ? 8 : uses;
        expect(results.filter(Boolean)).toHaveLength(expected);
        expect(
          (await db.select().from(schema.invites).where(eq(schema.invites.id, id)))[0].useCount,
        ).toBe(expected);
        if (uses > 0)
          expect(await validateAndConsumeInvite(db, schema, token, "again@example.com")).toBeNull();
      });
    }

    test("one TOTP step upgrades exactly one of eight pending sessions", async () => {
      const secret = generateSecret().base32;
      await db.insert(schema.mfaTotp).values({
        id: Bun.randomUUIDv7(),
        userId,
        encryptedSecret: await encrypt(secret, encryptionKey),
        verified: 1,
        createdAt: new Date().toISOString(),
      });
      const sessions = await Promise.all(
        Array.from({ length: 8 }, () => createSession(db, schema, userId, 3600, 0)),
      );
      const routes = createTotpRoutes({
        db,
        internalSchema: schema,
        usersTable: users,
        config,
        extractAuth: async () => null,
      });
      const code = generateTotpCode(secret);
      const responses = await Promise.all(
        sessions.map((session) =>
          routes["/auth/mfa/totp/verify"]!.POST!(
            new Request("http://localhost/auth/mfa/totp/verify", {
              method: "POST",
              headers: { cookie: `bunbase_session=${session}`, "content-type": "application/json" },
              body: JSON.stringify({ code }),
            }),
          ),
        ),
      );
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 401)).toHaveLength(7);
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(inArray(schema.sessions.id, sessions));
      expect(rows.filter((r: any) => r.mfaVerified === 1)).toHaveLength(1);
    });

    test("a backup code is single-use under concurrent verification", async () => {
      await storeBackupCodes(db, schema, userId, ["concurrent-backup"]);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => verifyBackupCode(db, schema, userId, "concurrent-backup")),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    async function seedOrganization() {
      const id = Bun.randomUUIDv7();
      orgIds.push(id);
      const targets = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
      const now = new Date().toISOString();
      await db.insert(schema.organizations).values({
        id,
        name: "Security test",
        slug: id,
        ownerId: userId,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(schema.organizationMembers).values(
        [userId, ...targets].map((id2, i) => ({
          id: Bun.randomUUIDv7(),
          orgId: id,
          userId: id2,
          role: i === 0 ? "owner" : "member",
          createdAt: now,
        })),
      );
      return { id, targets };
    }
    async function state(id: string) {
      const org = (
        await db.select().from(schema.organizations).where(eq(schema.organizations.id, id))
      )[0];
      const members = await db
        .select()
        .from(schema.organizationMembers)
        .where(eq(schema.organizationMembers.orgId, id));
      return {
        ownerId: org.ownerId,
        members: members
          .map((m: any) => ({ userId: m.userId, role: m.role }))
          .sort((a: any, b: any) => a.userId.localeCompare(b.userId)),
      };
    }

    test("organization rule helpers enforce membership and roles", async () => {
      const { id, targets } = await seedOrganization();
      const auth = (id: string) => ({ id, email: "roles@example.com", role: "user" });
      expect(await orgMember(id, auth(userId), db)).toBe(true);
      expect(await orgAdmin(id, auth(userId), db)).toBe(true);
      expect(await orgOwner(id, auth(userId), db)).toBe(true);
      expect(await orgMember(id, auth(targets[0]!), db)).toBe(true);
      expect(await orgAdmin(id, auth(targets[0]!), db)).toBe(false);
      expect(await orgOwner(id, auth(targets[0]!), db)).toBe(false);
      await db
        .update(schema.organizationMembers)
        .set({ role: "admin" })
        .where(eq(schema.organizationMembers.userId, targets[0]!));
      expect(await orgAdmin(id, auth(targets[0]!), db)).toBe(true);
      expect(await orgOwner(id, auth(targets[0]!), db)).toBe(false);
      for (const helper of [orgMember, orgAdmin, orgOwner]) {
        expect(await helper(id, auth("unrelated-user"), db)).toBe(false);
        expect(await helper("missing-org", auth(userId), db)).toBe(false);
        expect(await helper("' OR 1=1 --", auth(userId), db)).toBe(false);
        expect(await helper(id, null, db)).toBe(false);
      }
    });

    test("competing ownership transfers leave exactly one owner", async () => {
      const { id, targets } = await seedOrganization();
      const results = await Promise.allSettled(
        targets.map((target) => transferOwnership(db, driver, schema, id, userId, target)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const after = await state(id);
      expect(after.members.filter((m: any) => m.role === "owner")).toEqual([
        { userId: after.ownerId, role: "owner" },
      ]);
      expect(after.members.find((m: any) => m.userId === userId)?.role).toBe("admin");
    });

    for (const stage of ["organization", "promote", "demote"] as const) {
      test(`ownership transfer rolls back when ${stage} write fails`, async () => {
        const { id, targets } = await seedOrganization();
        const before = await state(id);
        const trigger = `reject_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        const table = stage === "organization" ? "_organizations" : "_organization_members";
        const when =
          stage === "organization"
            ? `NEW.id = '${id}'`
            : `NEW.org_id = '${id}' AND NEW.user_id = '${stage === "promote" ? targets[0] : userId}'`;
        const q = adapter.quoteIdentifier.bind(adapter);
        try {
          if (driver === "sqlite") {
            await adapter.rawExecute(
              `CREATE TRIGGER ${q(trigger)} BEFORE UPDATE ON ${q(table)} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END`,
            );
          } else if (driver === "postgres") {
            await adapter.rawExecute(
              `CREATE FUNCTION ${q(trigger)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${when} THEN RAISE EXCEPTION 'injected transfer failure'; END IF; RETURN NEW; END $$`,
            );
            await adapter.rawExecute(
              `CREATE TRIGGER ${q(trigger)} BEFORE UPDATE ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION ${q(trigger)}()`,
            );
          } else {
            await adapter.rawExecute(
              `CREATE TRIGGER ${q(trigger)} BEFORE UPDATE ON ${q(table)} FOR EACH ROW BEGIN IF ${when} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected transfer failure'; END IF; END`,
            );
          }
          await expect(
            transferOwnership(db, driver, schema, id, userId, targets[0]!),
          ).rejects.toThrow();
          expect(await state(id)).toEqual(before);
        } finally {
          await adapter.rawExecute(
            `DROP TRIGGER IF EXISTS ${q(trigger)}${driver === "postgres" ? ` ON ${q(table)}` : ""}`,
          );
          if (driver === "postgres")
            await adapter.rawExecute(`DROP FUNCTION IF EXISTS ${q(trigger)}()`);
        }
      });
    }
  });
}
