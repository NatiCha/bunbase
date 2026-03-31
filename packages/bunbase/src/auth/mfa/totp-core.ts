/**
 * Built-in TOTP (RFC 6238) implementation using Bun.CryptoHasher HMAC.
 * Zero external dependencies.
 * @module
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode bytes to base32 (RFC 4648). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

/** Decode base32 (RFC 4648) to bytes. */
export function base32Decode(encoded: string): Uint8Array {
  const stripped = encoded.replace(/=+$/, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (let i = 0; i < stripped.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(stripped[i]!);
    if (idx === -1) throw new Error(`Invalid base32 character: ${stripped[i]}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

/** Generate a random TOTP secret (20 bytes = 160 bits, standard for SHA-1). */
export function generateSecret(): { bytes: Uint8Array; base32: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return { bytes, base32: base32Encode(bytes) };
}

/**
 * Generate a TOTP code from a secret at a given time.
 *
 * @param secretBase32 - Base32-encoded shared secret
 * @param time - Unix timestamp in seconds (defaults to now)
 * @param period - Time step in seconds (default 30)
 * @param digits - Number of digits (default 6)
 */
export function generateTotpCode(
  secretBase32: string,
  time?: number,
  period = 30,
  digits = 6,
): string {
  const counter = Math.floor((time ?? Math.floor(Date.now() / 1000)) / period);
  return hotpCode(secretBase32, counter, digits);
}

/**
 * Validate a TOTP code against a secret within a time window.
 *
 * @returns The time-step delta if valid, or null if invalid.
 *          Delta 0 means the code matches the current period.
 */
export function validateTotpCode(
  secretBase32: string,
  code: string,
  window = 1,
  time?: number,
  period = 30,
  digits = 6,
): number | null {
  const now = time ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / period);

  for (let delta = -window; delta <= window; delta++) {
    const expected = hotpCode(secretBase32, counter + delta, digits);
    // Constant-time comparison to prevent timing attacks
    if (timingSafeEqual(code, expected)) {
      return delta;
    }
  }

  return null;
}

/**
 * Build an otpauth:// URI for QR code scanning.
 */
export function buildTotpUri(
  secretBase32: string,
  issuer: string,
  label: string,
  period = 30,
  digits = 6,
  algorithm = "SHA1",
): string {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedLabel = encodeURIComponent(label);
  return (
    `otpauth://totp/${encodedIssuer}:${encodedLabel}` +
    `?secret=${secretBase32}` +
    `&issuer=${encodedIssuer}` +
    `&algorithm=${algorithm}` +
    `&digits=${digits}` +
    `&period=${period}`
  );
}

// ─── Internal helpers ───

/** Compute HOTP code (RFC 4226) using Bun.CryptoHasher HMAC. */
function hotpCode(secretBase32: string, counter: number, digits: number): string {
  const secret = base32Decode(secretBase32);

  // Convert counter to 8-byte big-endian
  const counterBuf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  // HMAC-SHA1
  const hasher = new Bun.CryptoHasher("sha1", secret);
  hasher.update(counterBuf);
  const hmac = hasher.digest();

  // Dynamic truncation (RFC 4226 section 5.4)
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, "0");
}

/** Constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Use the same constant-time comparison as crypto
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}
