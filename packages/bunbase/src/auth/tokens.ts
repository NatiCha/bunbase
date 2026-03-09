/**
 * Shared token hashing utilities for auth flows.
 * @module
 */

/**
 * Hash a raw token string using SHA-256, returning a lowercase hex digest.
 *
 * @param token - The raw token string to hash.
 * @returns Lowercase hex-encoded SHA-256 digest.
 */
export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
