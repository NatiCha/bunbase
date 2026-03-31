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
}

export function defineAuthHooks(hooks: AuthHooks): AuthHooks {
  return hooks;
}
