import type { Table, InferSelectModel, InferInsertModel } from "drizzle-orm";

// ─── Type machinery ───────────────────────────────────────────────────────────

type TableKeys<S> = {
  [K in keyof S]: S[K] extends Table ? K : never;
}[keyof S];

export interface ListParams {
  filter?: Record<string, unknown>;
  cursor?: string;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
}

export interface ListResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TableClient<TSelect, TInsert> {
  list(params?: ListParams): Promise<ListResponse<TSelect>>;
  get(id: string): Promise<TSelect | null>;
  create(data: TInsert): Promise<TSelect>;
  update(id: string, data: Partial<TInsert>): Promise<TSelect | null>;
  delete(id: string): Promise<{ deleted: boolean }>;
}

export type TSBaseAPI<S> = {
  [K in TableKeys<S>]: S[K] extends Table
    ? TableClient<InferSelectModel<S[K]>, InferInsertModel<S[K]>>
    : never;
};

// ─── Client options ───────────────────────────────────────────────────────────

interface TSBaseClientOptions {
  url: string;
}

// ─── CSRF helper ──────────────────────────────────────────────────────────────

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createTSBaseClient<S extends Record<string, unknown>>(
  options: TSBaseClientOptions,
) {
  const baseUrl = options.url.replace(/\/$/, "");

  function mutationHeaders(): HeadersInit {
    return {
      "Content-Type": "application/json",
      "X-CSRF-Token": getCsrfToken(),
    };
  }

  // Proxy-based API client: client.api.tableName.list() etc.
  const api = new Proxy({} as TSBaseAPI<S>, {
    get(_target, tableName: string) {
      const tableUrl = `${baseUrl}/api/${tableName}`;

      const tableClient: TableClient<unknown, unknown> = {
        async list(params?: ListParams): Promise<ListResponse<unknown>> {
          const url = new URL(tableUrl);
          if (params?.filter) {
            url.searchParams.set("filter", JSON.stringify(params.filter));
          }
          if (params?.cursor) url.searchParams.set("cursor", params.cursor);
          if (params?.limit != null) url.searchParams.set("limit", String(params.limit));
          if (params?.sort) url.searchParams.set("sort", params.sort);
          if (params?.order) url.searchParams.set("order", params.order);

          const res = await fetch(url.toString(), { credentials: "include" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw Object.assign(new Error((err as any)?.error?.message ?? "List failed"), {
              code: (err as any)?.error?.code,
            });
          }
          return res.json();
        },

        async get(id: string): Promise<unknown> {
          const res = await fetch(`${tableUrl}/${id}`, { credentials: "include" });
          if (res.status === 404) return null;
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw Object.assign(new Error((err as any)?.error?.message ?? "Get failed"), {
              code: (err as any)?.error?.code,
            });
          }
          return res.json();
        },

        async create(data: unknown): Promise<unknown> {
          const res = await fetch(tableUrl, {
            method: "POST",
            headers: mutationHeaders(),
            credentials: "include",
            body: JSON.stringify(data),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw Object.assign(new Error((err as any)?.error?.message ?? "Create failed"), {
              code: (err as any)?.error?.code,
            });
          }
          return res.json();
        },

        async update(id: string, data: unknown): Promise<unknown> {
          const res = await fetch(`${tableUrl}/${id}`, {
            method: "PATCH",
            headers: mutationHeaders(),
            credentials: "include",
            body: JSON.stringify(data),
          });
          if (res.status === 404) return null;
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw Object.assign(new Error((err as any)?.error?.message ?? "Update failed"), {
              code: (err as any)?.error?.code,
            });
          }
          return res.json();
        },

        async delete(id: string): Promise<{ deleted: boolean }> {
          const res = await fetch(`${tableUrl}/${id}`, {
            method: "DELETE",
            headers: { "X-CSRF-Token": getCsrfToken() },
            credentials: "include",
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw Object.assign(new Error((err as any)?.error?.message ?? "Delete failed"), {
              code: (err as any)?.error?.code,
            });
          }
          return res.json();
        },
      };

      return tableClient;
    },
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

  return { api, auth, files };
}
