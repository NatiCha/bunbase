import { afterAll, describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createTestServer } from "../testing/index.ts";
import { allowAll } from "../rules/helpers.ts";

const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  emailVerified: integer("email_verified").notNull().default(0),
});

const server = await createTestServer({
  schema: { users },
  rules: { users: allowAll },
  config: {
    auth: {
      mfa: {
        totp: { enabled: true, issuer: "TestApp" },
        encryptionKey: "test-totp-encryption-key",
      },
    },
  },
});

afterAll(() => server.cleanup());

const csrfToken = "test-csrf-token";

/**
 * Helper: fetch with session cookie forwarding.
 * Extracts Set-Cookie from response and returns it for next request.
 */
function extractSessionCookie(res: Response): string | null {
  const setCookies = res.headers.getAll("set-cookie");
  for (const c of setCookies) {
    if (c.startsWith("bunbase_session=")) {
      return c.split(";")[0]!;
    }
  }
  return null;
}

async function fetchWithSession(
  path: string,
  init: RequestInit = {},
  sessionCookie?: string | null,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("x-csrf-token", csrfToken);
  let cookieStr = `csrf_token=${csrfToken}`;
  if (sessionCookie) cookieStr += `; ${sessionCookie}`;
  headers.set("cookie", cookieStr);
  return globalThis.fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

describe("TOTP MFA flow", () => {
  test("full setup → login → MFA verify flow", async () => {
    // 1. Register a user
    const registerRes = await fetchWithSession("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "mfa@test.com", password: "password123" }),
    });
    expect(registerRes.status).toBe(201);
    let session = extractSessionCookie(registerRes);

    // 2. Setup TOTP (user is authenticated from registration)
    const setupRes = await fetchWithSession("/auth/mfa/totp/setup", { method: "POST" }, session);
    expect(setupRes.status).toBe(200);
    const setupData = await setupRes.json();
    expect(setupData.secret).toBeDefined();
    expect(setupData.uri).toContain("otpauth://totp/");
    expect(setupData.uri).toContain("TestApp");

    // 3. Verify setup with a valid TOTP code
    const { generateTotpCode } = await import("../auth/mfa/totp-core.ts");

    const code = generateTotpCode(setupData.secret);
    const verifySetupRes = await fetchWithSession("/auth/mfa/totp/verify-setup", {
      method: "POST",
      body: JSON.stringify({ code }),
    }, session);
    expect(verifySetupRes.status).toBe(200);
    const verifySetupData = await verifySetupRes.json();
    expect(verifySetupData.backupCodes).toBeDefined();
    expect(verifySetupData.backupCodes.length).toBe(10);

    // 4. Check MFA status
    const statusRes = await fetchWithSession("/auth/mfa/status", {}, session);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.totp).toBe(true);

    // 5. Login fresh — should get MFA challenge
    const loginRes = await fetchWithSession("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "mfa@test.com", password: "password123" }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    expect(loginData.mfaRequired).toBe(true);
    expect(loginData.mfaMethods).toContain("totp");
    const pendingSession = extractSessionCookie(loginRes);

    // 6. Try to access protected resource with pending MFA session — should fail
    const meRes = await fetchWithSession("/auth/me", {}, pendingSession);
    expect(meRes.status).toBe(401);

    // 7. Complete MFA with TOTP code
    const mfaCode = generateTotpCode(setupData.secret);
    const mfaVerifyRes = await fetchWithSession("/auth/mfa/totp/verify", {
      method: "POST",
      body: JSON.stringify({ code: mfaCode }),
    }, pendingSession);
    expect(mfaVerifyRes.status).toBe(200);
    const mfaVerifyData = await mfaVerifyRes.json();
    expect(mfaVerifyData.user).toBeDefined();
    expect(mfaVerifyData.user.email).toBe("mfa@test.com");

    // 8. Now /auth/me should work with same session (now upgraded)
    const meRes2 = await fetchWithSession("/auth/me", {}, pendingSession);
    expect(meRes2.status).toBe(200);
  });

  test("backup code works during MFA challenge", async () => {
    // Register + setup TOTP
    const registerRes = await fetchWithSession("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "backup@test.com", password: "password123" }),
    });
    expect(registerRes.status).toBe(201);
    let session = extractSessionCookie(registerRes);

    const setupRes = await fetchWithSession("/auth/mfa/totp/setup", { method: "POST" }, session);
    const setupData = await setupRes.json();

    const { generateTotpCode: genCode } = await import("../auth/mfa/totp-core.ts");

    const verifySetupRes = await fetchWithSession("/auth/mfa/totp/verify-setup", {
      method: "POST",
      body: JSON.stringify({ code: genCode(setupData.secret) }),
    }, session);
    const { backupCodes } = await verifySetupRes.json();
    expect(backupCodes.length).toBe(10);

    // Login again — should get MFA challenge
    const loginRes = await fetchWithSession("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "backup@test.com", password: "password123" }),
    });
    const loginData = await loginRes.json();
    expect(loginData.mfaRequired).toBe(true);
    const pendingSession = extractSessionCookie(loginRes);

    // Use backup code
    const backupRes = await fetchWithSession("/auth/mfa/backup/verify", {
      method: "POST",
      body: JSON.stringify({ code: backupCodes[0] }),
    }, pendingSession);
    expect(backupRes.status).toBe(200);
    const backupData = await backupRes.json();
    expect(backupData.user).toBeDefined();

    // Login again — same backup code should not work (single-use)
    const loginRes2 = await fetchWithSession("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "backup@test.com", password: "password123" }),
    });
    expect((await loginRes2.json()).mfaRequired).toBe(true);
    const pendingSession2 = extractSessionCookie(loginRes2);

    const backupRes2 = await fetchWithSession("/auth/mfa/backup/verify", {
      method: "POST",
      body: JSON.stringify({ code: backupCodes[0] }),
    }, pendingSession2);
    expect(backupRes2.status).toBe(401);
  });
});
