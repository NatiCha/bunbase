import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InferInsertModel, InferSelectModel, Table } from "drizzle-orm";
import type React from "react";
import { useState } from "react";
import {
  createBunBaseClient,
  type ListParams,
  type ListResponse,
  type TableClient,
} from "../client.ts";
import { AuthProvider, useAuth } from "./auth.tsx";
import type { BunBaseReactOptions } from "./types.ts";

export { useAuth } from "./auth.tsx";
export type { AuthUser, BunBaseReactOptions, UseAuthReturn } from "./types.ts";

// ─── Type machinery ───────────────────────────────────────────────────────────

type TableKeys<S> = {
  [K in keyof S]: S[K] extends Table ? K : never;
}[keyof S];

interface TableQueryClient<TSelect, TInsert> {
  list: {
    queryOptions: (params?: ListParams) => {
      queryKey: readonly unknown[];
      queryFn: () => Promise<ListResponse<TSelect>>;
    };
    queryKey: (params?: ListParams) => readonly unknown[];
  };
  /**
   * Query options for `listAll` — fetches all records in a single request.
   *
   * @example
   * ```tsx
   * const { data = [] } = useQuery(api.tasks.listAll.queryOptions({ filter: { done: false } }));
   * ```
   */
  listAll: {
    queryOptions: (params?: Omit<ListParams, "cursor" | "limit">) => {
      queryKey: readonly unknown[];
      queryFn: () => Promise<TSelect[]>;
    };
    queryKey: (params?: Omit<ListParams, "cursor" | "limit">) => readonly unknown[];
  };
  get: {
    queryOptions: (
      id: string,
      opts?: { expand?: string[] },
    ) => {
      queryKey: readonly unknown[];
      queryFn: () => Promise<TSelect | null>;
    };
    queryKey: (id: string, opts?: { expand?: string[] }) => readonly unknown[];
  };
  create: {
    mutationOptions: (opts?: {
      onSuccess?: (data: TSelect) => void;
      onError?: (err: unknown) => void;
    }) => {
      mutationFn: (data: TInsert) => Promise<TSelect>;
      onSuccess?: (data: TSelect) => void;
      onError?: (err: unknown) => void;
    };
  };
  update: {
    mutationOptions: (opts?: {
      onSuccess?: (data: TSelect | null) => void;
      onError?: (err: unknown) => void;
    }) => {
      mutationFn: (args: { id: string; data: Partial<TInsert> }) => Promise<TSelect | null>;
      onSuccess?: (data: TSelect | null) => void;
      onError?: (err: unknown) => void;
    };
  };
  delete: {
    mutationOptions: (opts?: {
      onSuccess?: (data: { deleted: boolean }) => void;
      onError?: (err: unknown) => void;
    }) => {
      mutationFn: (args: { id: string }) => Promise<{ deleted: boolean }>;
      onSuccess?: (data: { deleted: boolean }) => void;
      onError?: (err: unknown) => void;
    };
  };
}

type BunBaseReactAPI<S> = {
  [K in TableKeys<S>]: S[K] extends Table
    ? TableQueryClient<InferSelectModel<S[K]>, InferInsertModel<S[K]>>
    : never;
};

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createBunBaseReact<S extends Record<string, unknown>>(
  options: BunBaseReactOptions & { schema: S },
) {
  const baseUrl = options.url.replace(/\/$/, "");
  const client = createBunBaseClient<S>(options);

  // Proxy that returns queryOptions/mutationOptions per table
  const api = new Proxy({} as BunBaseReactAPI<S>, {
    get(_target, tableName: string | symbol) {
      if (typeof tableName !== "string") return undefined;
      if (tableName === "then" || tableName === "catch" || tableName === "finally")
        return undefined;
      // client.api proxy validates the table name and throws if invalid
      const tableClient = (client.api as any)[tableName] as TableClient<unknown, unknown>;

      const tableQueryClient: TableQueryClient<unknown, unknown> = {
        list: {
          queryOptions(params?: ListParams) {
            return {
              queryKey: ["bunbase", tableName, "list", params ?? {}] as const,
              queryFn: () => tableClient.list(params),
            };
          },
          queryKey(params?: ListParams) {
            return ["bunbase", tableName, "list", params ?? {}] as const;
          },
        },
        listAll: {
          queryOptions(params?: Omit<ListParams, "cursor" | "limit">) {
            return {
              queryKey: ["bunbase", tableName, "listAll", params ?? {}] as const,
              queryFn: () => tableClient.listAll(params),
            };
          },
          queryKey(params?: Omit<ListParams, "cursor" | "limit">) {
            return ["bunbase", tableName, "listAll", params ?? {}] as const;
          },
        },
        get: {
          queryOptions(id: string, opts?: { expand?: string[] }) {
            return {
              queryKey: ["bunbase", tableName, "get", id, opts ?? {}] as const,
              queryFn: () => tableClient.get(id, opts),
            };
          },
          queryKey(id: string, opts?: { expand?: string[] }) {
            return ["bunbase", tableName, "get", id, opts ?? {}] as const;
          },
        },
        create: {
          mutationOptions(opts?: {
            onSuccess?: (data: unknown) => void;
            onError?: (err: unknown) => void;
          }) {
            return {
              mutationFn: (data: unknown) => tableClient.create(data),
              ...(opts?.onSuccess ? { onSuccess: opts.onSuccess } : {}),
              ...(opts?.onError ? { onError: opts.onError } : {}),
            };
          },
        },
        update: {
          mutationOptions(opts?: {
            onSuccess?: (data: unknown) => void;
            onError?: (err: unknown) => void;
          }) {
            return {
              mutationFn: ({ id, data }: { id: string; data: unknown }) =>
                tableClient.update(id, data as Partial<unknown>),
              ...(opts?.onSuccess ? { onSuccess: opts.onSuccess } : {}),
              ...(opts?.onError ? { onError: opts.onError } : {}),
            };
          },
        },
        delete: {
          mutationOptions(opts?: {
            onSuccess?: (data: { deleted: boolean }) => void;
            onError?: (err: unknown) => void;
          }) {
            return {
              mutationFn: ({ id }: { id: string }) => tableClient.delete(id),
              ...(opts?.onSuccess ? { onSuccess: opts.onSuccess } : {}),
              ...(opts?.onError ? { onError: opts.onError } : {}),
            };
          },
        },
      };

      return tableQueryClient;
    },
  });

  function BunBaseProvider({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(
      () =>
        options.queryClient ??
        new QueryClient({
          defaultOptions: { queries: { staleTime: 30_000 } },
        }),
    );

    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider baseUrl={baseUrl}>{children}</AuthProvider>
      </QueryClientProvider>
    );
  }

  return { BunBaseProvider, api, useAuth, client };
}
