/**
 * BunBase public API surface.
 *
 * This module re-exports the server, rules, hooks, auth, jobs, and type utilities
 * needed to build BunBase applications from scratch.
 * @module
 */
export { createServer } from "./core/server.ts";
export { defineConfig } from "./core/config.ts";
export { defineRules } from "./rules/types.ts";
export { defineHooks } from "./hooks/types.ts";
export { defineAuthHooks } from "./hooks/auth-types.ts";
export { defineJobs } from "./jobs/types.ts";
export {
  authenticated,
  admin,
  ownerOnly,
  adminOrOwner,
  allowAll,
  isSet,
  isChanged,
  fieldLength,
  collection,
  now,
  todayStart,
  todayEnd,
  monthStart,
  yearStart,
} from "./rules/helpers.ts";
export { requireAuth, ApiError } from "./api/helpers.ts";
export { isBearerOnly } from "./auth/middleware.ts";
export type { BunBaseConfig, ResolvedConfig } from "./core/config.ts";
export type { BunBaseServer, CreateServerOptions, ExtendContext, RouteMap } from "./core/server.ts";
export type { AuthUser, BunBaseErrorCode, BunBaseErrorEnvelope } from "./api/types.ts";
export type { Rules, TableRules, RuleArg, RuleFunction, RuleResult } from "./rules/types.ts";
export type { FilterOperators } from "./crud/filters.ts";
export type {
  Hooks,
  TableHooks,
  BeforeCreateContext,
  AfterCreateContext,
  BeforeUpdateContext,
  AfterUpdateContext,
  BeforeDeleteContext,
  AfterDeleteContext,
  BeforeCreateFn,
  AfterCreateFn,
  BeforeUpdateFn,
  AfterUpdateFn,
  BeforeDeleteFn,
  AfterDeleteFn,
} from "./hooks/types.ts";
export type { JobDefinition, JobContext, Jobs } from "./jobs/types.ts";
export type {
  AuthHooks,
  BeforeRegisterContext,
  AfterRegisterContext,
  BeforeLoginContext,
  AfterLoginContext,
  BeforeOAuthLoginContext,
  AfterOAuthLoginContext,
  BeforePasswordResetContext,
  AfterPasswordResetContext,
  AfterEmailVerifyContext,
  BeforeRegisterFn,
  AfterRegisterFn,
  BeforeLoginFn,
  AfterLoginFn,
  BeforeOAuthLoginFn,
  AfterOAuthLoginFn,
  BeforePasswordResetFn,
  AfterPasswordResetFn,
  AfterEmailVerifyFn,
} from "./hooks/auth-types.ts";
export type { AnyDb, AnyTable, AnyColumn, Dialect } from "./core/db-types.ts";
export type { DatabaseAdapter } from "./core/adapter.ts";
export type { DatabaseConfig, ResolvedDatabaseConfig } from "./core/config.ts";
export { createGenericOAuthProvider as defineOAuthProvider } from "./auth/oauth/generic.ts";
export type { CustomOAuthProviderConfig, OAuthProvider, OAuthUserInfo } from "./auth/oauth/types.ts";
export { defineRelations, MAX_RELATION_DEPTH } from "./crud/relations.ts";
