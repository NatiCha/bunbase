import { afterEach, expect, spyOn, test } from "bun:test";
import { discord } from "../auth/oauth/discord.ts";
import { github } from "../auth/oauth/github.ts";
import { google } from "../auth/oauth/google.ts";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

// ─── GitHub ──────────────────────────────────────────────────────────────────

test("github.getAuthUrl builds correct authorization URL", () => {
  const url = github.getAuthUrl(
    "gh-client-id",
    "http://localhost/auth/oauth/github/callback",
    "state-abc",
  );
  expect(url).toContain("https://github.com/login/oauth/authorize");
  expect(url).toContain("client_id=gh-client-id");
  expect(url).toContain("state=state-abc");
  // scope includes user:email (URL-encoded)
  expect(url).toContain("scope=");
});

test("github.exchangeCode posts to token endpoint and returns accessToken", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ access_token: "gh-token-abc" }) as any,
  );

  const result = await github.exchangeCode(
    "code123",
    "client-id",
    "client-secret",
    "http://localhost/callback",
  );

  expect(result.accessToken).toBe("gh-token-abc");
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("github.com");
  expect(init.method).toBe("POST");
});

test("github.getUserInfo fetches user and emails, returns primary email", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        id: 99999,
        name: "Alice",
        avatar_url: "https://avatars.githubusercontent.com/alice.png",
      }) as any,
    )
    .mockResolvedValueOnce(
      Response.json([
        { email: "secondary@example.com", primary: false },
        { email: "primary@example.com", primary: true },
      ]) as any,
    );

  const info = await github.getUserInfo("gh-token");
  expect(info.id).toBe("99999");
  expect(info.email).toBe("primary@example.com");
  expect(info.name).toBe("Alice");
  expect(info.avatar).toBe("https://avatars.githubusercontent.com/alice.png");
});

test("github.getUserInfo falls back to first email when none is primary", async () => {
  fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ id: 1, name: "Bob" }) as any)
    .mockResolvedValueOnce(Response.json([{ email: "only@example.com", primary: false }]) as any);

  const info = await github.getUserInfo("gh-token");
  expect(info.email).toBe("only@example.com");
});

// ─── Google ──────────────────────────────────────────────────────────────────

test("google.getAuthUrl includes openid, email and profile scopes", () => {
  const url = google.getAuthUrl(
    "google-client",
    "http://localhost/auth/oauth/google/callback",
    "state-xyz",
  );
  expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url).toContain("openid");
  expect(url).toContain("email");
  expect(url).toContain("profile");
  expect(url).toContain("state=state-xyz");
  expect(url).toContain("access_type=offline");
  expect(url).toContain("response_type=code");
});

test("google.exchangeCode posts to token endpoint and returns accessToken", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ access_token: "google-token-xyz" }) as any,
  );

  const result = await google.exchangeCode(
    "code",
    "client-id",
    "client-secret",
    "http://localhost/callback",
  );

  expect(result.accessToken).toBe("google-token-xyz");
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("googleapis.com");
  expect(init.method).toBe("POST");
});

test("google.getUserInfo returns id, email, name and avatar", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      id: "g-user-123",
      email: "user@gmail.com",
      name: "Google User",
      picture: "https://lh3.googleusercontent.com/photo.jpg",
    }) as any,
  );

  const info = await google.getUserInfo("google-token");
  expect(info.id).toBe("g-user-123");
  expect(info.email).toBe("user@gmail.com");
  expect(info.name).toBe("Google User");
  expect(info.avatar).toBe("https://lh3.googleusercontent.com/photo.jpg");
});

// ─── Discord ─────────────────────────────────────────────────────────────────

test("discord.getAuthUrl includes identify and email scopes", () => {
  const url = discord.getAuthUrl(
    "discord-client",
    "http://localhost/auth/oauth/discord/callback",
    "state-def",
  );
  expect(url).toContain("https://discord.com/api/oauth2/authorize");
  expect(url).toContain("identify");
  expect(url).toContain("email");
  expect(url).toContain("state=state-def");
  expect(url).toContain("response_type=code");
});

test("discord.exchangeCode posts form-encoded body to token endpoint", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ access_token: "discord-token-abc" }) as any,
  );

  const result = await discord.exchangeCode(
    "code",
    "client-id",
    "client-secret",
    "http://localhost/callback",
  );

  expect(result.accessToken).toBe("discord-token-abc");
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("discord.com");
  expect(init.method).toBe("POST");
});

test("discord.getUserInfo returns user fields with CDN avatar URL", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      id: "disc-456",
      email: "user@discord.com",
      username: "DiscordUser#1234",
      avatar: "abc123hash",
    }) as any,
  );

  const info = await discord.getUserInfo("discord-token");
  expect(info.id).toBe("disc-456");
  expect(info.email).toBe("user@discord.com");
  expect(info.name).toBe("DiscordUser#1234");
  expect(info.avatar).toContain("cdn.discordapp.com/avatars/disc-456/abc123hash");
});

test("discord.getUserInfo returns undefined avatar when avatar field is null", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      id: "disc-789",
      email: "noavatar@discord.com",
      username: "NoAvatar",
      avatar: null,
    }) as any,
  );

  const info = await discord.getUserInfo("discord-token");
  expect(info.avatar).toBeUndefined();
});
