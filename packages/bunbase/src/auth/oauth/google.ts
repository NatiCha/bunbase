import type { OAuthProvider, OAuthUserInfo } from "./types.ts";

/**
 * Built-in Google OAuth provider implementation.
 * @module
 */

/**
 * Google OAuth provider with default `openid email profile` scopes.
 *
 * @remarks Includes `access_type=offline` in auth URL generation.
 */
export const google: OAuthProvider = {
  name: "google",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: ["openid", "email", "profile"],

  getAuthUrl(clientId, redirectUri, state) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      state,
      access_type: "offline",
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
      name?: string;
      picture?: string;
      verified_email?: boolean;
    };
    return {
      id: data.id,
      email: data.email,
      name: data.name,
      avatar: data.picture,
      emailVerified: data.verified_email,
    };
  },
};
