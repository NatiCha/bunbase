import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { getTableName, type InferSelectModel, Table } from "drizzle-orm";
import type React from "react";
import { useEffect, useState } from "react";
import {
  type ClientInsert,
  createBunBaseClient,
  type ListParams,
  type ListResponse,
  type ServerFields,
  type TableChangeEvent,
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
   * Infinite query options wired to cursor pagination. Use with
   * `useInfiniteQuery`; `getNextPageParam` reads `nextCursor` from each page.
   *
   * @example
   * ```tsx
   * const q = useInfiniteQuery(api.tasks.infiniteQueryOptions({ limit: 20 }));
   * const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
   * ```
   */
  infiniteQueryOptions: (params?: Omit<ListParams, "cursor">) => {
    queryKey: readonly unknown[];
    queryFn: (ctx: { pageParam: string | undefined }) => Promise<ListResponse<TSelect>>;
    initialPageParam: string | undefined;
    getNextPageParam: (lastPage: ListResponse<TSelect>) => string | undefined;
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

type BunBaseReactAPI<S, F extends ServerFields<S> = Record<never, never>> = {
  [K in TableKeys<S>]: S[K] extends Table
    ? TableQueryClient<InferSelectModel<S[K]>, ClientInsert<S[K], K extends keyof F ? F[K] : never>>
    : never;
};

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createBunBaseReact<
  S extends Record<string, unknown>,
  const F extends ServerFields<S> = Record<never, never>,
>(options: BunBaseReactOptions & { schema: S; serverFields?: F }) {
  const baseUrl = options.url.replace(/\/$/, "");
  const client = createBunBaseClient<S, F>(options);

  // Map JS schema key (camelCase) → SQL table name (snake_case) so realtime
  // subscriptions (keyed by SQL name) can invalidate react-query keys (keyed by
  // the JS schema key).
  const sqlTableNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.schema)) {
    if (value instanceof Table) {
      try {
        sqlTableNames[key] = getTableName(value);
      } catch {
        // not a table — skip
      }
    }
  }

  // Proxy that returns queryOptions/mutationOptions per table
  const api = new Proxy({} as BunBaseReactAPI<S, F>, {
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
        infiniteQueryOptions(params?: Omit<ListParams, "cursor">) {
          return {
            queryKey: ["bunbase", tableName, "infinite", params ?? {}] as const,
            queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
              tableClient.list({ ...params, cursor: pageParam }),
            initialPageParam: undefined as string | undefined,
            getNextPageParam: (lastPage: ListResponse<unknown>) => lastPage.nextCursor ?? undefined,
          };
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

  /**
   * Subscribe to realtime changes for one or more tables and automatically
   * invalidate the matching react-query keys (list / listAll / get / infinite),
   * so consumers no longer hand-write `invalidateQueries`.
   *
   * Pass the JS schema key(s) (e.g. `"tasks"`), not the SQL table name.
   *
   * @example
   * ```tsx
   * useRealtimeInvalidation("tasks");          // single table
   * useRealtimeInvalidation(["tasks", "projects"]); // many
   * const data = useQuery(api.tasks.list.queryOptions()).data;
   * ```
   */
  function useRealtimeInvalidation(
    tables: keyof S | Array<keyof S>,
    opts?: { onChange?: (table: keyof S, event: TableChangeEvent) => void },
  ): void {
    const queryClient = useQueryClient();
    const keys = (Array.isArray(tables) ? tables : [tables]) as string[];
    // Stable dependency for the effect across renders.
    // `depKey` is a stable serialization of `tables`; re-subscribe only when the
    // set of tables changes, not on every render (keys/opts are fresh each render).
    const depKey = keys.join(",");

    // biome-ignore lint/correctness/useExhaustiveDependencies: depKey proxies the table set; see above
    useEffect(() => {
      const unsubscribers = keys.map((jsKey) => {
        const sqlName = sqlTableNames[jsKey] ?? jsKey;
        return client.realtime.subscribe(sqlName, (event) => {
          queryClient.invalidateQueries({ queryKey: ["bunbase", jsKey] });
          opts?.onChange?.(jsKey as keyof S, event);
        });
      });
      return () => {
        for (const off of unsubscribers) off();
      };
    }, [depKey, queryClient]);
  }

  return {
    BunBaseProvider,
    api,
    useAuth,
    useRealtimeInvalidation,
    client,
  };
}
