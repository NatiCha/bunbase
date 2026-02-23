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
}

export function defineAuthHooks(hooks: AuthHooks): AuthHooks {
  return hooks;
}
