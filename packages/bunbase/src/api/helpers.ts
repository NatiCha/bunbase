import type { AuthUser } from "./types.ts";

/**
 * Common API helpers for authentication and JSON error responses.
 * @module
 */

/** Error class carrying a stable error code and HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Require an authenticated user.
 *
 * @throws {ApiError} UNAUTHORIZED when `auth` is null.
 */
export function requireAuth(auth: AuthUser | null): AuthUser {
  if (!auth) {
    throw new ApiError("UNAUTHORIZED", "Not authenticated", 401);
  }
  return auth;
}

/**
 * Build a standard BunBase JSON error response envelope.
 *
 * @returns `Response` with `{ error: { code, message } }`.
 */
export function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}
