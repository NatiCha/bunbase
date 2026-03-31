import { describe, expect, test } from "bun:test";
import { decrypt, encrypt, resolveMfaEncryptionKey } from "../auth/encryption.ts";

describe("AES-256-GCM encryption", () => {
  const key = "test-encryption-key-for-totp-secrets";

  test("round-trip encrypt/decrypt", async () => {
    const plaintext = "JBSWY3DPEHPK3PXP"; // typical TOTP base32 secret
    const encrypted = await encrypt(plaintext, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  test("encrypted output has iv:ciphertext format", async () => {
    const encrypted = await encrypt("hello", key);
    const parts = encrypted.split(":");
    expect(parts.length).toBe(2);
  });

  test("different encryptions produce different ciphertexts (random IV)", async () => {
    const a = await encrypt("same-input", key);
    const b = await encrypt("same-input", key);
    expect(a).not.toBe(b);
    // But both decrypt to the same value
    expect(await decrypt(a, key)).toBe("same-input");
    expect(await decrypt(b, key)).toBe("same-input");
  });

  test("wrong key fails to decrypt", async () => {
    const encrypted = await encrypt("secret", key);
    await expect(decrypt(encrypted, "wrong-key")).rejects.toThrow();
  });

  test("invalid format throws", async () => {
    await expect(decrypt("not-valid", key)).rejects.toThrow();
  });
});

describe("resolveMfaEncryptionKey", () => {
  test("returns config key when provided", () => {
    expect(resolveMfaEncryptionKey("my-key", false)).toBe("my-key");
  });

  test("returns fallback key in dev mode", () => {
    const key = resolveMfaEncryptionKey(undefined, true);
    expect(key).toContain("dev");
  });

  test("throws in production without key", () => {
    expect(() => resolveMfaEncryptionKey(undefined, false)).toThrow();
  });
});
