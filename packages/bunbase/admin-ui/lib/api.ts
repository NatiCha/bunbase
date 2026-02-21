const BASE = "/_admin/api";

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error((err as any)?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    credentials: "include",
    headers: { "x-csrf-token": getCsrfToken() },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error((err as any)?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error((err as any)?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error((err as any)?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface AdminSession {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: string;
}

export interface AdminOAuthAccount {
  id: string;
  user_id: string;
  provider: string;
  provider_account_id: string;
  created_at: string;
}

export interface AdminFile {
  id: string;
  collection: string;
  record_id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  created_at: string;
}

export interface RequestLog {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId: string | null;
  timestamp: string;
}

export interface TableInfo {
  name: string;
  count: number;
  type: "base" | "auth";
}

export interface RecordPage {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdminConfig {
  development: boolean;
  dbPath: string;
  storage: {
    driver: string;
    maxFileSize: number;
    allowedMimeTypes: string[] | null;
  };
  cors: { origins: string[] };
  auth: {
    tokenExpiry: number;
    hasEmail: boolean;
    hasGoogle: boolean;
    hasGithub: boolean;
    hasDiscord: boolean;
  };
}

export const api = {
  getUsers: () => get<AdminUser[]>("/users"),
  getSessions: () => get<AdminSession[]>("/sessions"),
  deleteSession: (id: string) => del<{ deleted: boolean }>(`/sessions/${id}`),
  getOAuth: () => get<AdminOAuthAccount[]>("/oauth"),
  getFiles: () => get<AdminFile[]>("/files"),
  deleteFile: (id: string) => del<{ deleted: boolean }>(`/files/${id}`),
  getLogs: () => get<RequestLog[]>("/logs"),
  clearLogs: () => del<{ cleared: boolean }>("/logs"),
  getSchema: () => get<Record<string, Array<{ key: string; name: string; type: string; notNull: boolean; primary: boolean }>>>("/schema"),
  getConfig: () => get<AdminConfig>("/config"),
  getTables: () => get<TableInfo[]>("/tables"),
  getRecords: (
    table: string,
    opts: { page?: number; limit?: number; search?: string; sort?: string; order?: string },
  ) => {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.search) params.set("search", opts.search);
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.order) params.set("order", opts.order);
    return get<RecordPage>(`/records/${table}?${params}`);
  },
  createRecord: (table: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/records/${table}`, data),
  updateRecord: (table: string, id: string, data: Record<string, unknown>) =>
    patch<Record<string, unknown>>(`/records/${table}/${id}`, data),
  deleteRecord: (table: string, id: string) =>
    del<{ deleted: boolean }>(`/records/${table}/${id}`),
};
