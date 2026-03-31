import type { OAuthUserInfo } from "../auth/oauth/types.ts";

/**
 * Auth lifecycle hook types.
 * @module
 */

export type BeforeRegisterContext = {
  email: string;
  data: Record<string, unknown>;
  req: Request;
};

export type AfterRegisterContext = {
  user: Record<string, unknown>;
  userId: string;
};

export type BeforeLoginContext = {
  email: string;
  req: Request;
};

export type AfterLoginContext = {
  user: Record<string, unknown>;
  userId: string;
};

export type BeforeOAuthLoginContext = {
  provider: string;
  userInfo: OAuthUserInfo;
  req: Request;
};

export type AfterOAuthLoginContext = {
  user: Record<string, unknown>;
  userId: string;
  provider: string;
  isNewUser: boolean;
};

export type BeforePasswordResetContext = {
  userId: string;
};

export type AfterPasswordResetContext = {
  userId: string;
};

export type AfterEmailVerifyContext = {
  userId: string;
};

export type BeforeRegisterFn = (ctx: BeforeRegisterContext) =>
  | Record<string, unknown>
  | undefined
  | void
  // biome-ignore lint/suspicious/noConfusingVoidType: void needed for async hooks that return nothing
  | Promise<Record<string, unknown> | undefined | void>;

export type AfterRegisterFn = (ctx: AfterRegisterContext) => void | Promise<void>;

export type BeforeLoginFn = (ctx: BeforeLoginContext) => void | Promise<void>;

export type AfterLoginFn = (ctx: AfterLoginContext) => void | Promise<void>;

export type BeforeOAuthLoginFn = (ctx: BeforeOAuthLoginContext) => void | Promise<void>;

export type AfterOAuthLoginFn = (ctx: AfterOAuthLoginContext) => void | Promise<void>;

export type BeforePasswordResetFn = (ctx: BeforePasswordResetContext) => void | Promise<void>;

export type AfterPasswordResetFn = (ctx: AfterPasswordResetContext) => void | Promise<void>;

export type AfterEmailVerifyFn = (ctx: AfterEmailVerifyContext) => void | Promise<void>;

// ─── Magic Link & OTP Hooks ───

export type BeforeMagicLinkLoginContext = {
  email: string;
  req: Request;
};

export type AfterMagicLinkLoginContext = {
  user: Record<string, unknown>;
  userId: string;
  isNewUser: boolean;
};

export type BeforeOtpLoginContext = {
  email: string;
  req: Request;
};

export type AfterOtpLoginContext = {
  user: Record<string, unknown>;
  userId: string;
};

export type BeforeMagicLinkLoginFn = (ctx: BeforeMagicLinkLoginContext) => void | Promise<void>;
export type AfterMagicLinkLoginFn = (ctx: AfterMagicLinkLoginContext) => void | Promise<void>;
export type BeforeOtpLoginFn = (ctx: BeforeOtpLoginContext) => void | Promise<void>;
export type AfterOtpLoginFn = (ctx: AfterOtpLoginContext) => void | Promise<void>;

// ─── MFA Hooks ───

export type AfterMfaSetupContext = {
  userId: string;
  method: "totp";
};

export type AfterMfaVerifyContext = {
  userId: string;
  method: "totp" | "backup_code";
};

export type AfterMfaDisableContext = {
  userId: string;
  method: "totp";
};

export type AfterMfaSetupFn = (ctx: AfterMfaSetupContext) => void | Promise<void>;
export type AfterMfaVerifyFn = (ctx: AfterMfaVerifyContext) => void | Promise<void>;
export type AfterMfaDisableFn = (ctx: AfterMfaDisableContext) => void | Promise<void>;

// ─── Passkey Hooks ───

export type AfterPasskeyRegisterContext = {
  userId: string;
  credentialId: string;
};

export type AfterPasskeyLoginContext = {
  userId: string;
  credentialId: string;
};

export type AfterPasskeyRemoveContext = {
  userId: string;
  credentialId: string;
};

export type AfterPasskeyRegisterFn = (ctx: AfterPasskeyRegisterContext) => void | Promise<void>;
export type AfterPasskeyLoginFn = (ctx: AfterPasskeyLoginContext) => void | Promise<void>;
export type AfterPasskeyRemoveFn = (ctx: AfterPasskeyRemoveContext) => void | Promise<void>;

// ─── Account Deletion Hooks ───

export type BeforeAccountDeleteContext = {
  userId: string;
  req: Request;
};

export type AfterAccountDeleteContext = {
  userId: string;
  email: string;
};

export type BeforeAccountDeleteFn = (ctx: BeforeAccountDeleteContext) => void | Promise<void>;
export type AfterAccountDeleteFn = (ctx: AfterAccountDeleteContext) => void | Promise<void>;

// ─── Guest Auth Hooks ───

export type AfterGuestCreateContext = {
  guestId: string;
};

export type AfterGuestConvertContext = {
  guestId: string;
  userId: string;
  email: string;
};

export type AfterGuestCreateFn = (ctx: AfterGuestCreateContext) => void | Promise<void>;
export type AfterGuestConvertFn = (ctx: AfterGuestConvertContext) => void | Promise<void>;

// ─── SMS OTP Hooks ───

export type BeforeSmsOtpLoginContext = {
  phone: string;
  req: Request;
};

export type AfterSmsOtpLoginContext = {
  user: Record<string, unknown>;
  userId: string;
};

export type BeforeSmsOtpLoginFn = (ctx: BeforeSmsOtpLoginContext) => void | Promise<void>;
export type AfterSmsOtpLoginFn = (ctx: AfterSmsOtpLoginContext) => void | Promise<void>;

// ─── Invitation Hooks ───

export type AfterInviteCreateContext = {
  inviteId: string;
  email?: string;
  invitedBy: string;
};

export type AfterInviteAcceptContext = {
  inviteId: string;
  userId: string;
  email: string;
};

export type AfterInviteCreateFn = (ctx: AfterInviteCreateContext) => void | Promise<void>;
export type AfterInviteAcceptFn = (ctx: AfterInviteAcceptContext) => void | Promise<void>;

// ─── Organization Hooks ───

export type AfterOrgCreateContext = {
  organization: Record<string, unknown>;
  userId: string;
};

export type AfterOrgMemberAddContext = {
  orgId: string;
  userId: string;
  role: string;
};

export type AfterOrgMemberRemoveContext = {
  orgId: string;
  userId: string;
};

export type AfterOrgInviteAcceptContext = {
  orgId: string;
  userId: string;
  email: string;
};

export type AfterOrgCreateFn = (ctx: AfterOrgCreateContext) => void | Promise<void>;
export type AfterOrgMemberAddFn = (ctx: AfterOrgMemberAddContext) => void | Promise<void>;
export type AfterOrgMemberRemoveFn = (ctx: AfterOrgMemberRemoveContext) => void | Promise<void>;
export type AfterOrgInviteAcceptFn = (ctx: AfterOrgInviteAcceptContext) => void | Promise<void>;

export interface AuthHooks {
  beforeRegister?: BeforeRegisterFn;
  afterRegister?: AfterRegisterFn;
  beforeLogin?: BeforeLoginFn;
  afterLogin?: AfterLoginFn;
  beforeOAuthLogin?: BeforeOAuthLoginFn;
  afterOAuthLogin?: AfterOAuthLoginFn;
  beforePasswordReset?: BeforePasswordResetFn;
  afterPasswordReset?: AfterPasswordResetFn;
  afterEmailVerify?: AfterEmailVerifyFn;
  // Passwordless
  beforeMagicLinkLogin?: BeforeMagicLinkLoginFn;
  afterMagicLinkLogin?: AfterMagicLinkLoginFn;
  beforeOtpLogin?: BeforeOtpLoginFn;
  afterOtpLogin?: AfterOtpLoginFn;
  // MFA
  afterMfaSetup?: AfterMfaSetupFn;
  afterMfaVerify?: AfterMfaVerifyFn;
  afterMfaDisable?: AfterMfaDisableFn;
  // Passkeys
  afterPasskeyRegister?: AfterPasskeyRegisterFn;
  afterPasskeyLogin?: AfterPasskeyLoginFn;
  afterPasskeyRemove?: AfterPasskeyRemoveFn;
  // Account deletion
  beforeAccountDelete?: BeforeAccountDeleteFn;
  afterAccountDelete?: AfterAccountDeleteFn;
  // Guest auth
  afterGuestCreate?: AfterGuestCreateFn;
  afterGuestConvert?: AfterGuestConvertFn;
  // SMS OTP
  beforeSmsOtpLogin?: BeforeSmsOtpLoginFn;
  afterSmsOtpLogin?: AfterSmsOtpLoginFn;
  // Invitations
  afterInviteCreate?: AfterInviteCreateFn;
  afterInviteAccept?: AfterInviteAcceptFn;
  // Organizations
  afterOrgCreate?: AfterOrgCreateFn;
  afterOrgMemberAdd?: AfterOrgMemberAddFn;
  afterOrgMemberRemove?: AfterOrgMemberRemoveFn;
  afterOrgInviteAccept?: AfterOrgInviteAcceptFn;
}

export function defineAuthHooks(hooks: AuthHooks): AuthHooks {
  return hooks;
}
