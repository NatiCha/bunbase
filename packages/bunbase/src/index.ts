/**
 * BunBase public API surface.
 *
 * This module re-exports the server, rules, hooks, auth, jobs, and type utilities
 * needed to build BunBase applications from scratch.
 * @module
 */

export { ApiError, requireAuth } from "./api/helpers.ts";
export type { AuthUser, BunBaseErrorCode, BunBaseErrorEnvelope } from "./api/types.ts";
export { isBearerOnly } from "./auth/middleware.ts";
export { createGenericOAuthProvider as defineOAuthProvider } from "./auth/oauth/generic.ts";
export type {
  CustomOAuthProviderConfig,
  OAuthProvider,
  OAuthUserInfo,
} from "./auth/oauth/types.ts";
export type {
  BunBaseAPI,
  ChannelClient,
  ListParams,
  ListResponse,
  PresenceEvent,
  TableChangeEvent,
  TableClient,
} from "./client.ts";
export { createBunBaseClient } from "./client.ts";
export type { DatabaseAdapter } from "./core/adapter.ts";
export type {
  BunBaseConfig,
  DatabaseConfig,
  ResolvedConfig,
  ResolvedDatabaseConfig,
} from "./core/config.ts";
export { defineConfig } from "./core/config.ts";
export type { AnyColumn, AnyDb, AnyTable, Dialect } from "./core/db-types.ts";
export type { BunBaseServer, CreateServerOptions, ExtendContext, RouteMap } from "./core/server.ts";
export { createServer } from "./core/server.ts";
export type { FilterOperators } from "./crud/filters.ts";
export { defineRelations, MAX_RELATION_DEPTH } from "./crud/relations.ts";
export type {
  AfterEmailVerifyContext,
  AfterEmailVerifyFn,
  AfterLoginContext,
  AfterLoginFn,
  AfterOAuthLoginContext,
  AfterOAuthLoginFn,
  AfterPasswordResetContext,
  AfterPasswordResetFn,
  AfterRegisterContext,
  AfterRegisterFn,
  AuthHooks,
  BeforeLoginContext,
  BeforeLoginFn,
  BeforeOAuthLoginContext,
  BeforeOAuthLoginFn,
  BeforePasswordResetContext,
  BeforePasswordResetFn,
  BeforeRegisterContext,
  BeforeRegisterFn,
} from "./hooks/auth-types.ts";
export { defineAuthHooks } from "./hooks/auth-types.ts";
export type {
  AfterCreateContext,
  AfterCreateFn,
  AfterDeleteContext,
  AfterDeleteFn,
  AfterUpdateContext,
  AfterUpdateFn,
  BeforeCreateContext,
  BeforeCreateFn,
  BeforeDeleteContext,
  BeforeDeleteFn,
  BeforeUpdateContext,
  BeforeUpdateFn,
  HookRequest,
  Hooks,
  TableHooks,
} from "./hooks/types.ts";
export { defineHooks } from "./hooks/types.ts";
export type { JobContext, JobDefinition, Jobs } from "./jobs/types.ts";
export { defineJobs } from "./jobs/types.ts";
export type {
  DevMailServer,
  DevMailServerConfig,
  ReceivedEmail,
} from "./mailer/dev-server.ts";
export { createDevMailServer } from "./mailer/dev-server.ts";
export type {
  EmailMessage,
  EmailVerificationTemplateContext,
  Mailer,
  MailerConfig,
  MailerTemplates,
  PasswordResetTemplateContext,
  SendOptions,
  TemplateResult,
} from "./mailer/index.ts";
export { createMailer, MailerError } from "./mailer/index.ts";
export type { SmtpConfig } from "./mailer/transports/smtp.ts";
export { createSmtpTransport } from "./mailer/transports/smtp.ts";
export {
  admin,
  adminOrOwner,
  allowAll,
  authenticated,
  collection,
  fieldLength,
  isChanged,
  isSet,
  monthStart,
  now,
  ownerOnly,
  todayEnd,
  todayStart,
  yearStart,
} from "./rules/helpers.ts";
export type {
  RuleArg,
  RuleFunction,
  RuleResult,
  Rules,
  TableRules,
  TableRulesFor,
} from "./rules/types.ts";
export { defineRules } from "./rules/types.ts";
export type { FileRecord, FilesContext } from "./storage/files-context.ts";
