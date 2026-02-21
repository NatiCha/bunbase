import type { AuthUser } from "./types.ts";

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

export function requireAuth(auth: AuthUser | null): AuthUser {
  if (!auth) {
    throw new ApiError("UNAUTHORIZED", "Not authenticated", 401);
  }
  return auth;
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } }, { status });
}
