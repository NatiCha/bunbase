import type { OAuthProvider, OAuthUserInfo } from "./types.ts";

/**
 * Built-in Discord OAuth provider implementation.
 * @module
 */

/** Discord OAuth provider with `identify` and `email` scopes. */
export const discord: OAuthProvider = {
  name: "discord",
  authorizationUrl: "https://discord.com/api/oauth2/authorize",
  tokenUrl: "https://discord.com/api/oauth2/token",
  userInfoUrl: "https://discord.com/api/users/@me",
  scopes: ["identify", "email"],

  getAuthUrl(clientId, redirectUri, state) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      state,
    });
    return `${this.authorizationUrl}?${params}`;
  },

  async exchangeCode(code, clientId, clientSecret, redirectUri) {
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const data = (await res.json()) as { access_token: string };
    return { accessToken: data.access_token };
  },

  async getUserInfo(accessToken): Promise<OAuthUserInfo> {
    const res = await fetch(this.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as {
      id: string;
      email: string;
      username: string;
      avatar?: string;
      verified?: boolean;
    };
    return {
      id: data.id,
      email: data.email,
      name: data.username,
      avatar: data.avatar
        ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
        : undefined,
      emailVerified: data.verified,
    };
  },
};
