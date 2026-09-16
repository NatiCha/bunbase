import { afterAll, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { hashToken } from "../auth/tokens.ts";
import { createTestServer } from "../testing/index.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
});
const server = await createTestServer({
  schema: { users },
  config: {
    auth: { mfa: { passkeys: { enabled: true, rpId: "localhost", rpName: "BunBase Test" } } },
  },
});
afterAll(() => server.cleanup());

test("SimpleWebAuthn 14 generates registration options and stores the challenge", async () => {
  const alice = await server.loginAs("passkey@example.com");
  const res = await alice.fetch("/auth/passkeys/register/options", { method: "POST" });
  expect(res.status).toBe(200);
  const options = await res.json();
  expect(options.rp).toEqual({ id: "localhost", name: "BunBase Test" });
  expect(options.user.name).toBe("passkey@example.com");
  expect(options.challenge).toBeString();
  const rows = await server.adapter.rawQuery<{ token_hash: string }>(
    "SELECT token_hash FROM _verification_tokens WHERE user_id = $userId AND type = $type",
    { $userId: alice.userId, $type: "passkey_registration" },
  );
  expect(rows[0]?.token_hash).toBe(await hashToken(options.challenge));
  const invalid = await alice.fetch("/auth/passkeys/register/verify", {
    method: "POST",
    body: JSON.stringify({ response: {} }),
  });
  expect(invalid.status).toBe(400);
});

test("SimpleWebAuthn 14 generates login options without exposing an account", async () => {
  const res = await server.fetch("/auth/passkeys/login/options", {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const options = await res.json();
  expect(options.rpId).toBe("localhost");
  expect(options.challenge).toBeString();
});
