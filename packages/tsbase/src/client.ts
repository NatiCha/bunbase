import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";

interface TSBaseClientOptions {
  url: string;
}

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

export function createTSBaseClient<TRouter extends AnyTRPCRouter>(
  options: TSBaseClientOptions,
) {
  const baseUrl = options.url.replace(/\/$/, "");

  const trpc = createTRPCClient<TRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers() {
          return {
            "X-CSRF-Token": getCsrfToken(),
          };
        },
        fetch(url, opts) {
          return fetch(url, {
            ...(opts as RequestInit),
            credentials: "include",
          });
        },
      }) as any,
    ],
  });

  const auth = {
    async register(data: Record<string, unknown> & {
      email: string;
      password: string;
    }) {
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      return res.json() as Promise<{ user: Record<string, unknown> }>;
    },

    async login(data: { email: string; password: string }) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      return res.json() as Promise<{ user: Record<string, unknown> }>;
    },

    async logout() {
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: { "X-CSRF-Token": getCsrfToken() },
        credentials: "include",
      });
      return res.json() as Promise<{ success: boolean }>;
    },

    async me() {
      const res = await fetch(`${baseUrl}/auth/me`, {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        user: { id: string; email: string; role: string };
      };
      return data.user;
    },

    async requestPasswordReset(email: string) {
      const res = await fetch(`${baseUrl}/auth/request-password-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      return res.json();
    },

    async resetPassword(token: string, password: string) {
      const res = await fetch(`${baseUrl}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, password }),
      });
      return res.json();
    },

    async verifyEmail(token: string) {
      const res = await fetch(`${baseUrl}/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      return res.json();
    },

    oauthUrl(provider: "google" | "github" | "discord") {
      return `${baseUrl}/auth/oauth/${provider}`;
    },
  };

  const files = {
    async upload(collection: string, recordId: string, file: File) {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(
        `${baseUrl}/files/${collection}/${recordId}`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
        },
      );
      return res.json();
    },

    downloadUrl(fileId: string) {
      return `${baseUrl}/files/${fileId}`;
    },

    async delete(fileId: string) {
      const res = await fetch(`${baseUrl}/files/${fileId}`, {
        method: "DELETE",
        credentials: "include",
      });
      return res.json();
    },
  };

  return { trpc, auth, files };
}
