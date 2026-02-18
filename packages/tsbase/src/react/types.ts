import type { QueryClient } from "@tanstack/react-query";

export interface TSBaseReactOptions {
  url: string;
  queryClient?: QueryClient;
}

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  [key: string]: unknown;
}

export interface UseAuthReturn {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (data: Record<string, unknown> & { email: string; password: string }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refetch: () => void;
  oauthUrl: (provider: "google" | "github" | "discord") => string;
}
