/**
 * OAuth provider contracts used by BunBase OAuth routes.
 * @module
 */

export interface OAuthProvider {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  getAuthUrl(clientId: string, redirectUri: string, state: string): string;
  exchangeCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<{ accessToken: string }>;
  getUserInfo(accessToken: string): Promise<OAuthUserInfo>;
}

export interface OAuthUserInfo {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  /** Whether the provider has verified ownership of this email address. */
  emailVerified?: boolean;
}

export interface CustomOAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes?: string[];
  /** Normalize the provider's raw userInfo response into OAuthUserInfo. */
  mapUserInfo?: (raw: unknown) => OAuthUserInfo;
}
