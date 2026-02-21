import type { OAuthProvider, OAuthUserInfo } from "./types.ts";

export const github: OAuthProvider = {
  name: "github",
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.com/user",
  scopes: ["user:email"],

  getAuthUrl(clientId, redirectUri, state) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: this.scopes.join(" "),
      state,
    });
    return `${this.authorizationUrl}?${params}`;
  },

  async exchangeCode(code, clientId, clientSecret, redirectUri) {
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    const data = (await res.json()) as { access_token: string };
    return { accessToken: data.access_token };
  },

  async getUserInfo(accessToken): Promise<OAuthUserInfo> {
    const [userRes, emailRes] = await Promise.all([
      fetch(this.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ]);

    const user = (await userRes.json()) as {
      id: number;
      name?: string;
      avatar_url?: string;
    };
    const emails = (await emailRes.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;

    const primaryEmailEntry = emails.find((e) => e.primary) ?? emails[0];
    const primaryEmail = primaryEmailEntry?.email ?? "";

    return {
      id: String(user.id),
      email: primaryEmail,
      name: user.name,
      avatar: user.avatar_url,
      emailVerified: primaryEmailEntry?.verified,
    };
  },
};
