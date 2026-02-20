import type { OAuthProvider, OAuthUserInfo, CustomOAuthProviderConfig } from "./types.ts";

const DEFAULT_SCOPES = ["openid", "email", "profile"];

export function createGenericOAuthProvider(
  name: string,
  config: CustomOAuthProviderConfig,
): OAuthProvider {
  const scopes = config.scopes ?? DEFAULT_SCOPES;

  return {
    name,
    authorizationUrl: config.authorizationUrl,
    tokenUrl: config.tokenUrl,
    userInfoUrl: config.userInfoUrl,
    scopes,

    getAuthUrl(clientId: string, redirectUri: string, state: string): string {
      const url = new URL(config.authorizationUrl);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code, clientId, clientSecret, redirectUri) {
      const res = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const data = (await res.json()) as { access_token?: string };
      if (!data.access_token) {
        throw new Error(`OAuth token exchange failed for provider: ${name}`);
      }
      return { accessToken: data.access_token };
    },

    async getUserInfo(accessToken) {
      const res = await fetch(config.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const raw = (await res.json()) as unknown;

      if (config.mapUserInfo) {
        return config.mapUserInfo(raw);
      }

      // Default mapping: handles common OAuth provider response shapes
      const data = raw as Record<string, unknown>;
      const userInfo: OAuthUserInfo = {
        id: String(data.id ?? data.sub ?? ""),
        email: String(data.email ?? ""),
      };
      if (data.name != null) userInfo.name = String(data.name);
      const avatarVal = data.avatar ?? data.picture;
      if (avatarVal != null) userInfo.avatar = String(avatarVal);
      return userInfo;
    },
  };
}
