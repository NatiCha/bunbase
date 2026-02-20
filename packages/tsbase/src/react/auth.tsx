import React, { createContext, useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser, UseAuthReturn } from "./types.ts";

const AuthContext = createContext<{ baseUrl: string } | null>(null);

export function AuthProvider({
  baseUrl,
  children,
}: {
  baseUrl: string;
  children: React.ReactNode;
}) {
  return (
    <AuthContext.Provider value={{ baseUrl }}>{children}</AuthContext.Provider>
  );
}

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

export function useAuth(): UseAuthReturn {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within a TSBaseProvider");
  }
  const { baseUrl } = ctx;
  const queryClient = useQueryClient();

  const { data: user = null, isLoading } = useQuery<AuthUser | null>({
    queryKey: ["tsbase", "auth", "me"],
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error || "Login failed");
    }
    const data = await res.json();
    const authUser = data.user as AuthUser;
    queryClient.setQueryData(["tsbase", "auth", "me"], authUser);
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
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error || "Registration failed");
    }
    const result = await res.json();
    const authUser = result.user as AuthUser;
    queryClient.setQueryData(["tsbase", "auth", "me"], authUser);
    return authUser;
  };

  const logout = async (): Promise<void> => {
    await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "X-CSRF-Token": getCsrfToken() },
      credentials: "include",
    });
    queryClient.setQueryData(["tsbase", "auth", "me"], null);
    queryClient.invalidateQueries();
  };

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey: ["tsbase", "auth", "me"] });
  };

  const oauthUrl = (provider: string) => {
    return `${baseUrl}/auth/oauth/${provider}`;
  };

  return { user, isLoading, login, register, logout, refetch, oauthUrl };
}
