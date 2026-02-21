import { test, expect } from "bun:test";
import { hashPassword, verifyPassword } from "../auth/passwords.ts";

test("hashPassword returns a non-empty string different from the plaintext", async () => {
  const hash = await hashPassword("mysecretpassword");
  expect(typeof hash).toBe("string");
  expect(hash.length).toBeGreaterThan(0);
  expect(hash).not.toBe("mysecretpassword");
});

test("verifyPassword returns true for correct password", async () => {
  const hash = await hashPassword("correcthorse");
  expect(await verifyPassword("correcthorse", hash)).toBe(true);
});

test("verifyPassword returns false for incorrect password", async () => {
  const hash = await hashPassword("correcthorse");
  expect(await verifyPassword("wrongpassword", hash)).toBe(false);
});

test("two hashes of the same password are different (salted)", async () => {
  const hash1 = await hashPassword("samepassword");
  const hash2 = await hashPassword("samepassword");
  expect(hash1).not.toBe(hash2);
});
