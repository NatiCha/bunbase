import { useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { createContext, useContext } from "react";
import { BunBaseClientError } from "../client.ts";
import type { AuthUser, UseAuthReturn } from "./types.ts";

const AuthContext = createContext<{ baseUrl: string } | null>(null);

/** Parse a non-ok auth response and throw the consistent client error type. */
async function throwAuthError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; fields?: Record<string, string> };
  };
  throw new BunBaseClientError(body?.error?.message ?? fallback, {
    code: body?.error?.code,
    status: res.status,
    fields: body?.error?.fields,
  });
}

export function AuthProvider({
  baseUrl,
  children,
}: {
  baseUrl: string;
  children: React.ReactNode;
}) {
  return <AuthContext.Provider value={{ baseUrl }}>{children}</AuthContext.Provider>;
}

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.split(";").find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

export function useAuth(): UseAuthReturn {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within a BunBaseProvider");
  }
  const { baseUrl } = ctx;
  const queryClient = useQueryClient();

  const { data: user = null, isLoading } = useQuery<AuthUser | null>({
    queryKey: ["bunbase", "auth", "me"],
    queryFn: async () => {
      const res = await fetch(`${baseUrl}/auth/me`, {
        credentials: "include",
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user as AuthUser;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const login = async (email: string, password: string): Promise<AuthUser> => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) await throwAuthError(res, "Login failed");
    const data = await res.json();
    // When MFA is required the server returns `{ mfaRequired: true }` with no
    // `user`; surface that as an error so callers know a second factor is needed.
    if (data?.mfaRequired) {
      throw new BunBaseClientError("Multi-factor authentication required", {
        code: "MFA_REQUIRED",
        status: res.status,
      });
    }
    const authUser = data.user as AuthUser;
    queryClient.setQueryData(["bunbase", "auth", "me"], authUser);
    return authUser;
  };

  const register = async (
    data: Record<string, unknown> & { email: string; password: string },
  ): Promise<AuthUser> => {
    const res = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(data),
    });
    if (!res.ok) await throwAuthError(res, "Registration failed");
    const result = await res.json();
    const authUser = result.user as AuthUser;
    queryClient.setQueryData(["bunbase", "auth", "me"], authUser);
    return authUser;
  };

  const logout = async (): Promise<void> => {
    await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "X-CSRF-Token": getCsrfToken() },
      credentials: "include",
    });
    queryClient.setQueryData(["bunbase", "auth", "me"], null);
    queryClient.invalidateQueries();
  };

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey: ["bunbase", "auth", "me"] });
  };

  const oauthUrl = (provider: string) => {
    return `${baseUrl}/auth/oauth/${provider}`;
  };

  return { user, isLoading, login, register, logout, refetch, oauthUrl };
}
