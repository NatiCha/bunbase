/**
 * BunBase public API surface.
 *
 * This module re-exports the server, rules, hooks, auth, jobs, and type utilities
 * needed to build BunBase applications from scratch.
 * @module
 */

export { ApiError, requireAuth } from "./api/helpers.ts";
export type { AuthUser, BunBaseErrorCode, BunBaseErrorEnvelope } from "./api/types.ts";
export { decrypt, encrypt, resolveMfaEncryptionKey } from "./auth/encryption.ts";
export { validateAndConsumeInvite } from "./auth/invitations.ts";
export type { JwtPayload } from "./auth/jwt/core.ts";
export { isJwtToken, revokeJwt, signJwt, verifyJwt } from "./auth/jwt/core.ts";
export { generateBackupCodes, getMfaStatus } from "./auth/mfa/index.ts";
export { isBearerOnly, isServiceKey, SERVICE_KEY_USER } from "./auth/middleware.ts";
export { createGenericOAuthProvider as defineOAuthProvider } from "./auth/oauth/generic.ts";
export type {
  CustomOAuthProviderConfig,
  OAuthProvider,
  OAuthUserInfo,
} from "./auth/oauth/types.ts";
export {
  getOrgMembership,
  getUserOrganizations,
  requireOrgRole,
} from "./auth/organizations/helpers.ts";
export type { SmsMessage, SmsTransport } from "./auth/sms/types.ts";
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
export type {
  BunBaseServer,
  CreateServerOptions,
  ExtendContext,
  ExtendWebSocketDef,
  RouteMap,
} from "./core/server.ts";
export { createServer, defineWebSocket } from "./core/server.ts";
export type { FilterOperators } from "./crud/filters.ts";
export { defineRelations, MAX_RELATION_DEPTH } from "./crud/relations.ts";
export type {
  AfterAccountDeleteContext,
  AfterAccountDeleteFn,
  AfterEmailVerifyContext,
  AfterEmailVerifyFn,
  AfterGuestConvertContext,
  AfterGuestConvertFn,
  // Guest auth hooks
  AfterGuestCreateContext,
  AfterGuestCreateFn,
  AfterInviteAcceptContext,
  AfterInviteAcceptFn,
  // Invitation hooks
  AfterInviteCreateContext,
  AfterInviteCreateFn,
  AfterLoginContext,
  AfterLoginFn,
  AfterMagicLinkLoginContext,
  AfterMagicLinkLoginFn,
  AfterMfaDisableContext,
  AfterMfaDisableFn,
  // MFA hooks
  AfterMfaSetupContext,
  AfterMfaSetupFn,
  AfterMfaVerifyContext,
  AfterMfaVerifyFn,
  AfterOAuthLoginContext,
  AfterOAuthLoginFn,
  // Organization hooks
  AfterOrgCreateContext,
  AfterOrgCreateFn,
  AfterOrgInviteAcceptContext,
  AfterOrgInviteAcceptFn,
  AfterOrgMemberAddContext,
  AfterOrgMemberAddFn,
  AfterOrgMemberRemoveContext,
  AfterOrgMemberRemoveFn,
  AfterOtpLoginContext,
  AfterOtpLoginFn,
  AfterPasskeyLoginContext,
  AfterPasskeyLoginFn,
  // Passkey hooks
  AfterPasskeyRegisterContext,
  AfterPasskeyRegisterFn,
  AfterPasskeyRemoveContext,
  AfterPasskeyRemoveFn,
  AfterPasswordResetContext,
  AfterPasswordResetFn,
  AfterRegisterContext,
  AfterRegisterFn,
  AfterSmsOtpLoginContext,
  AfterSmsOtpLoginFn,
  AuthHooks,
  // Account deletion hooks
  BeforeAccountDeleteContext,
  BeforeAccountDeleteFn,
  BeforeLoginContext,
  BeforeLoginFn,
  // Passwordless hooks
  BeforeMagicLinkLoginContext,
  BeforeMagicLinkLoginFn,
  BeforeOAuthLoginContext,
  BeforeOAuthLoginFn,
  BeforeOtpLoginContext,
  BeforeOtpLoginFn,
  BeforePasswordResetContext,
  BeforePasswordResetFn,
  BeforeRegisterContext,
  BeforeRegisterFn,
  // SMS OTP hooks
  BeforeSmsOtpLoginContext,
  BeforeSmsOtpLoginFn,
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
  orgAdmin,
  orgMember,
  orgOwner,
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
