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
}
