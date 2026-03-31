/**
 * AES-256-GCM encryption for reversible secrets (e.g. TOTP shared secrets).
 * @module
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM
const TAG_LENGTH = 128; // 128-bit auth tag

/**
 * Derive a CryptoKey from a raw key string.
 * Accepts a 32-byte hex or base64 string, or uses SHA-256 to derive a key from
 * an arbitrary passphrase.
 */
async function deriveKey(rawKey: string): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey)),
  );
  return crypto.subtle.importKey("raw", keyBytes, { name: ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns a string in the format `base64(iv):base64(ciphertext)`.
 * The auth tag is appended to the ciphertext by the Web Crypto API.
 */
export async function encrypt(plaintext: string, rawKey: string): Promise<string> {
  const key = await deriveKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGORITHM, iv, tagLength: TAG_LENGTH }, key, encoded),
  );

  const ivB64 = Buffer.from(iv).toString("base64");
  const ctB64 = Buffer.from(ciphertext).toString("base64");

  return `${ivB64}:${ctB64}`;
}

/**
 * Decrypt a string produced by `encrypt()`.
 */
export async function decrypt(encrypted: string, rawKey: string): Promise<string> {
  const key = await deriveKey(rawKey);
  const [ivB64, ctB64] = encrypted.split(":");
  if (!ivB64 || !ctB64) throw new Error("Invalid encrypted format");

  const iv = new Uint8Array(Buffer.from(ivB64, "base64"));
  const ciphertext = new Uint8Array(Buffer.from(ctB64, "base64"));

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Resolve the MFA encryption key from config or environment.
 * In development mode, falls back to a deterministic key with a console warning.
 */
export function resolveMfaEncryptionKey(
  configKey: string | undefined,
  isDev: boolean,
): string {
  const key = configKey ?? process.env.BUNBASE_MFA_SECRET;
  if (key) return key;

  if (isDev) {
    console.warn(
      "[BunBase] WARNING: Using default MFA encryption key for development. " +
        "Set BUNBASE_MFA_SECRET or auth.mfa.encryptionKey in production.",
    );
    return "bunbase-dev-mfa-key-do-not-use-in-production";
  }

  throw new Error(
    "BunBase: BUNBASE_MFA_SECRET env var or auth.mfa.encryptionKey is required in production when MFA features are enabled",
  );
}
