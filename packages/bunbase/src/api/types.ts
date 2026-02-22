/**
 * Shared API contract types used by BunBase server and client helpers.
 * @module
 */
/**
 * Authenticated user context passed to hooks and rules.
 *
 * This interface is open for declaration merging — extend it in your project
 * to add type-safe custom fields from your users table:
 *
 * ```ts
 * // src/types.ts
 * declare module "bunbase" {
 *   interface AuthUser {
 *     organizationId: string;
 *     plan: "free" | "pro";
 *   }
 * }
 * ```
 */
export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

/**
 * Built-in BunBase error codes returned in `{ error: { code, message } }` payloads.
 * Custom `ApiError` codes may also appear if thrown by user hooks/routes.
 */
export type BunBaseErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "HOOK_ERROR"
  | "AUTH_HOOK_ERROR"
  | "INTERNAL_SERVER_ERROR"
  | "INTERNAL_ERROR";

/** Standard BunBase JSON error response envelope. */
export interface BunBaseErrorEnvelope {
  error: {
    code: BunBaseErrorCode | string;
    message: string;
  };
}
