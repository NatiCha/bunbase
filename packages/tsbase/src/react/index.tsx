import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { httpBatchLink } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { AuthProvider, useAuth } from "./auth.tsx";
import type { TSBaseReactOptions } from "./types.ts";

export type { TSBaseReactOptions, AuthUser, UseAuthReturn } from "./types.ts";
export { useAuth } from "./auth.tsx";

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

export function createTSBaseReact<TRouter extends AnyTRPCRouter>(
  options: TSBaseReactOptions,
) {
  const baseUrl = options.url.replace(/\/$/, "");
  const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<TRouter>();

  function TSBaseProvider({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(
      () =>
        options.queryClient ??
        new QueryClient({
          defaultOptions: { queries: { staleTime: 30_000 } },
        }),
    );

    const [trpcClient] = useState(() =>
      useTRPCClient.createClient({
        links: [
          httpBatchLink({
            url: `${baseUrl}/trpc`,
            headers() {
              return { "X-CSRF-Token": getCsrfToken() };
            },
            fetch(url, opts) {
              return fetch(url, {
                ...(opts as RequestInit),
                credentials: "include",
              });
            },
          }) as any,
        ],
      }),
    );

    return (
      <QueryClientProvider client={queryClient}>
        <TRPCProvider client={trpcClient} queryClient={queryClient}>
          <AuthProvider baseUrl={baseUrl}>{children}</AuthProvider>
        </TRPCProvider>
      </QueryClientProvider>
    );
  }

  return { TSBaseProvider, useTRPC, useTRPCClient, useAuth };
}
