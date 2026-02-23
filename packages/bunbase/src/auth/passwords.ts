/**
 * Password hashing helpers used by BunBase auth.
 * @module
 */

/** Hash a password using Bun's `argon2id` implementation. */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Verify a plaintext password against a stored password hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
