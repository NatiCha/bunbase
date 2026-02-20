import { test, expect } from "bun:test";
import { requireAuth, ApiError, errorResponse } from "../api/helpers.ts";
import type { AuthUser } from "../api/types.ts";

// ─── requireAuth ─────────────────────────────────────────────────────────────

test("requireAuth returns the user when authenticated", () => {
  const user: AuthUser = { id: "u1", email: "u@example.com", role: "user" };
  expect(requireAuth(user)).toBe(user);
});

test("requireAuth throws ApiError with UNAUTHORIZED code when auth is null", () => {
  let caught: unknown;
  try {
    requireAuth(null);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect((caught as ApiError).code).toBe("UNAUTHORIZED");
  expect((caught as ApiError).status).toBe(401);
});

test("requireAuth preserves extra user fields", () => {
  const user: AuthUser = { id: "u2", email: "admin@example.com", role: "admin", name: "Admin" };
  const result = requireAuth(user);
  expect(result.name).toBe("Admin");
});

// ─── ApiError ────────────────────────────────────────────────────────────────

test("ApiError has correct code, message, and status", () => {
  const err = new ApiError("FORBIDDEN", "Not allowed", 403);
  expect(err.code).toBe("FORBIDDEN");
  expect(err.message).toBe("Not allowed");
  expect(err.status).toBe(403);
  expect(err.name).toBe("ApiError");
});

test("ApiError is an instance of Error", () => {
  const err = new ApiError("NOT_FOUND", "Resource not found", 404);
  expect(err).toBeInstanceOf(Error);
});

// ─── errorResponse ────────────────────────────────────────────────────────────

test("errorResponse returns correct status and JSON body", async () => {
  const res = errorResponse("FORBIDDEN", "Access denied", 403);
  expect(res.status).toBe(403);
  const body = await res.json() as any;
  expect(body.error.code).toBe("FORBIDDEN");
  expect(body.error.message).toBe("Access denied");
});

test("errorResponse can produce 401 responses", async () => {
  const res = errorResponse("UNAUTHORIZED", "Not authenticated", 401);
  expect(res.status).toBe(401);
  const body = await res.json() as any;
  expect(body.error.code).toBe("UNAUTHORIZED");
});

test("errorResponse can produce 400 responses", async () => {
  const res = errorResponse("BAD_REQUEST", "Invalid JSON", 400);
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error.code).toBe("BAD_REQUEST");
});
