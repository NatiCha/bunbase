import type { InferInsertModel, InferSelectModel, Table } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import type { BunBaseErrorCode, BunBaseErrorEnvelope } from "./api/types.ts";

/**
 * BunBase TypeScript client SDK for CRUD, auth, files, and realtime.
 * @module
 */

// ─── Type machinery ───────────────────────────────────────────────────────────

type TableKeys<S> = {
  [K in keyof S]: S[K] extends Table ? K : never;
}[keyof S];

export interface ListParams<TExpand extends string = string> {
  /** JSON filter object encoded into `?filter=...`. */
  filter?: Record<string, unknown>;
  cursor?: string;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
  /** Relations to expand, e.g. `["owner", "project.team"]`. */
  expand?: TExpand[];
}

export interface ListResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

type ExpandKeys<TSelect> = Extract<keyof TSelect, string>;

export interface TableClient<
  TSelect,
  TInsert,
  TExpand extends string = ExpandKeys<TSelect> | string,
> {
  list(params?: ListParams<TExpand>): Promise<ListResponse<TSelect>>;
  /**
   * Fetch all records matching `params` in a single request.
   * Passes `limit=-1` to the server, which returns every matching record
   * with no cursor. Accepts the same filter/sort/expand params as `list()`.
   *
   * @example
   * ```ts
   * const allTasks = await client.api.tasks.listAll({ filter: { done: false } });
   * ```
   */
  listAll(params?: Omit<ListParams<TExpand>, "cursor" | "limit">): Promise<TSelect[]>;
  get(id: string, opts?: { expand?: TExpand[] }): Promise<TSelect | null>;
  create(data: TInsert): Promise<TSelect>;
  update(id: string, data: Partial<TInsert>): Promise<TSelect | null>;
  delete(id: string): Promise<{ deleted: boolean }>;
}

export type BunBaseAPI<S> = {
  [K in TableKeys<S>]: S[K] extends Table
    ? TableClient<InferSelectModel<S[K]>, InferInsertModel<S[K]>>
    : never;
};

// ─── Client options ───────────────────────────────────────────────────────────

interface BunBaseClientOptions {
  url: string;
  /** Bearer API key for server-side / CLI usage. When set, cookies and CSRF are omitted. */
  apiKey?: string;
}

export interface BunBaseClientError extends Error {
  code?: BunBaseErrorCode | string;
}

// ─── CSRF helper ──────────────────────────────────────────────────────────────

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.split(";").find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

async function throwApiError(res: Response, fallback: string): Promise<never> {
  const parsed = await res.json().catch(() => ({}) as Partial<BunBaseErrorEnvelope>);
  const message = parsed?.error?.message ?? fallback;
  const err = new Error(message) as BunBaseClientError;
  err.code = parsed?.error?.code;
  throw err;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a BunBase client instance.
 *
 * @example
 * ```ts
 * import * as schema from "./schema";
 * const client = createBunBaseClient({ url: "http://localhost:3000", schema });
 * const page = await client.api.tasks.list({ limit: 20, expand: ["owner"] });
 * ```
 */
export function createBunBaseClient<S extends Record<string, unknown>>(
  options: BunBaseClientOptions & { schema: S },
) {
  const baseUrl = options.url.replace(/\/$/, "");
  const apiKey = options.apiKey;
  const schemaKeys = Object.keys(options.schema);

  // Build a map from JS schema key (camelCase) → SQL table name (snake_case)
  // so the client constructs URLs that match the server's registered routes.
  const sqlTableNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.schema)) {
    try {
      const sqlName = getTableName(value as Table);
      if (sqlName) sqlTableNames[key] = sqlName;
    } catch {
      // not a table — skip
    }
  }

  // When an API key is set, use bearer auth and omit cookies/CSRF
  const credentials: RequestCredentials = apiKey ? "omit" : "include";

  function authHeaders(): HeadersInit {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  function mutationHeaders(): HeadersInit {
    if (apiKey) {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
    }
    return {
      "Content-Type": "application/json",
      "X-CSRF-Token": getCsrfToken(),
    };
  }

  // Proxy-based API client: client.api.tableName.list() etc.
  const api = new Proxy({} as BunBaseAPI<S>, {
    get(_target, tableName: string | symbol) {
      // Pass through symbol accesses (JS internals)
      if (typeof tableName !== "string") return undefined;
      // Pass through Promise/thenable protocol checks
      if (tableName === "then" || tableName === "catch" || tableName === "finally")
        return undefined;
      // Validate table name at access time when schema is available
      if (schemaKeys.length > 0 && !schemaKeys.includes(tableName)) {
        throw new Error(`'${tableName}' is not a valid table. Available: ${schemaKeys.join(", ")}`);
      }
      const sqlName = sqlTableNames[tableName] ?? tableName;
      const tableUrl = `${baseUrl}/api/${sqlName}`;

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
          if (params?.expand) url.searchParams.set("expand", params.expand.join(","));

          const res = await fetch(url.toString(), {
            credentials,
            headers: authHeaders(),
          });
          if (!res.ok) await throwApiError(res, "List failed");
          return res.json();
        },

        async listAll(params?: Omit<ListParams, "cursor" | "limit">): Promise<unknown[]> {
          const page = await tableClient.list({ ...params, limit: -1 });
          return page.data;
        },

        async get(id: string, opts?: { expand?: string[] }): Promise<unknown> {
          const url = new URL(`${tableUrl}/${id}`);
          if (opts?.expand) url.searchParams.set("expand", opts.expand.join(","));
          const res = await fetch(url.toString(), { credentials, headers: authHeaders() });
          if (res.status === 404) return null;
          if (!res.ok) await throwApiError(res, "Get failed");
          return res.json();
        },

        async create(data: unknown): Promise<unknown> {
          const res = await fetch(tableUrl, {
            method: "POST",
            headers: mutationHeaders(),
            credentials,
            body: JSON.stringify(data),
          });
          if (!res.ok) await throwApiError(res, "Create failed");
          return res.json();
        },

        async update(id: string, data: unknown): Promise<unknown> {
          const res = await fetch(`${tableUrl}/${id}`, {
            method: "PATCH",
            headers: mutationHeaders(),
            credentials,
            body: JSON.stringify(data),
          });
          if (res.status === 404) return null;
          if (!res.ok) await throwApiError(res, "Update failed");
          return res.json();
        },

        async delete(id: string): Promise<{ deleted: boolean }> {
          const res = await fetch(`${tableUrl}/${id}`, {
            method: "DELETE",
            headers: apiKey
              ? { Authorization: `Bearer ${apiKey}` }
              : { "X-CSRF-Token": getCsrfToken() },
            credentials,
          });
          if (!res.ok) await throwApiError(res, "Delete failed");
          return res.json();
        },
      };

      return tableClient;
    },
  });

  const auth = {
    async register(
      data: Record<string, unknown> & {
        email: string;
        password: string;
      },
    ) {
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials,
        body: JSON.stringify(data),
      });
      return res.json() as Promise<{ user: Record<string, unknown> }>;
    },

    async login(data: { email: string; password: string }) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials,
        body: JSON.stringify(data),
      });
      return res.json() as Promise<{ user: Record<string, unknown> }>;
    },

    async logout() {
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : { "X-CSRF-Token": getCsrfToken() },
        credentials,
      });
      return res.json() as Promise<{ success: boolean }>;
    },

    async me() {
      const res = await fetch(`${baseUrl}/auth/me`, {
        credentials,
        headers: authHeaders(),
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
      if (!res.ok) await throwApiError(res, "Email verification failed");
      return res.json();
    },

    async requestEmailVerification(email: string) {
      const res = await fetch(`${baseUrl}/auth/request-email-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      return res.json();
    },

    oauthUrl(provider: string) {
      return `${baseUrl}/auth/oauth/${provider}`;
    },

    apiKeys: {
      async create(data: { name: string; expiresInDays?: number }) {
        const res = await fetch(`${baseUrl}/auth/api-keys`, {
          method: "POST",
          headers: mutationHeaders(),
          credentials,
          body: JSON.stringify(data),
        });
        return res.json() as Promise<{
          id: string;
          name: string;
          keyPrefix: string;
          key: string;
          expiresAt: number | null;
          createdAt: string;
        }>;
      },

      async list() {
        const res = await fetch(`${baseUrl}/auth/api-keys`, {
          credentials,
          headers: authHeaders(),
        });
        return res.json() as Promise<
          Array<{
            id: string;
            userId: string;
            keyPrefix: string;
            name: string;
            expiresAt: number | null;
            lastUsedAt: string | null;
            createdAt: string;
          }>
        >;
      },

      async delete(id: string) {
        const res = await fetch(`${baseUrl}/auth/api-keys/${id}`, {
          method: "DELETE",
          headers: apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : { "X-CSRF-Token": getCsrfToken() },
          credentials,
        });
        return res.json() as Promise<{ deleted: boolean }>;
      },
    },
  };

  const files = {
    async upload(collection: string, recordId: string, file: File) {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${baseUrl}/files/${collection}/${recordId}`, {
        method: "POST",
        credentials,
        headers: authHeaders(),
        body: formData,
      });
      return res.json();
    },

    downloadUrl(fileId: string) {
      return `${baseUrl}/files/${fileId}`;
    },

    async delete(fileId: string) {
      const res = await fetch(`${baseUrl}/files/${fileId}`, {
        method: "DELETE",
        credentials,
        headers: authHeaders(),
      });
      return res.json();
    },
  };

  const realtime = createRealtimeClient(baseUrl, apiKey);

  return { api, auth, files, realtime };
}

// ─── Realtime client ─────────────────────────────────────────────────────────

export interface TableChangeEvent {
  action: "INSERT" | "UPDATE" | "DELETE";
  record?: Record<string, unknown>;
  id: string;
}

export interface ChannelClient {
  on(event: string, callback: (payload: unknown) => void): ChannelClient;
  subscribe(): ChannelClient;
  broadcast(event: string, payload: unknown): void;
  unsubscribe(): void;
  onPresence(callback: (event: PresenceEvent) => void): ChannelClient;
  track(meta?: Record<string, unknown>): ChannelClient;
  untrack(): void;
}

export type PresenceEvent =
  | {
      type: "state";
      channel: string;
      users: Array<{ userId: string; meta: Record<string, unknown> }>;
    }
  | { type: "join"; channel: string; user: { userId: string; meta: Record<string, unknown> } }
  | { type: "leave"; channel: string; userId: string }
  | { type: "update"; channel: string; user: { userId: string; meta: Record<string, unknown> } };

interface InternalChannelClient extends ChannelClient {
  _dispatchBroadcast(event: string, payload: unknown): void;
  _dispatchPresence(msg: Record<string, unknown>): void;
  _resubscribe(): void;
}

function createRealtimeClient(baseUrl: string, apiKey?: string) {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Track active table subscriptions for reconnect
  const tableListeners: Map<string, Set<(event: TableChangeEvent) => void>> = new Map();
  // Track channel objects for reconnect
  const channelObjects: Map<string, InternalChannelClient> = new Map();

  function send(msg: unknown) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function dispatch(msg: Record<string, unknown>) {
    const type = msg.type as string;
    if (type === "table:change") {
      const listeners = tableListeners.get(msg.table as string);
      if (listeners) {
        for (const cb of listeners) {
          cb({ action: msg.action as any, record: msg.record as any, id: msg.id as string });
        }
      }
    } else if (type === "broadcast") {
      const channel = channelObjects.get(msg.channel as string);
      channel?._dispatchBroadcast(msg.event as string, msg.payload);
    } else if (type.startsWith("presence:")) {
      const channel = channelObjects.get(msg.channel as string);
      channel?._dispatchPresence(msg);
    }
  }

  function resubscribeAll() {
    for (const table of tableListeners.keys()) {
      send({ type: "subscribe:table", table });
    }
    for (const channel of channelObjects.values()) {
      channel._resubscribe();
    }
  }

  function connect() {
    if (ws) return;
    const wsUrl = `${baseUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws"))}/realtime`;
    // Bun's WebSocket supports custom headers for server-side bearer auth.
    // Browser WebSocket API does not, so the header is only passed when an apiKey
    // is configured (server-side/CLI usage). Browser clients use cookie-based WS auth.
    ws =
      apiKey && typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
        ? new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } } as any)
        : new WebSocket(wsUrl);

    ws.onopen = () => {
      resubscribeAll();
    };

    ws.onmessage = (event) => {
      try {
        dispatch(JSON.parse(event.data as string) as Record<string, unknown>);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      ws = null;
      if (tableListeners.size > 0 || channelObjects.size > 0) {
        reconnectTimer = setTimeout(() => {
          connect();
        }, 2000);
      }
    };

    ws.onerror = () => {
      // onclose will handle reconnect
    };
  }

  function subscribe(table: string, callback: (event: TableChangeEvent) => void): () => void {
    const isNew = !tableListeners.has(table);
    if (isNew) tableListeners.set(table, new Set());
    tableListeners.get(table)?.add(callback);

    connect();
    if (isNew) {
      if (ws?.readyState === WebSocket.OPEN) {
        send({ type: "subscribe:table", table });
      }
      // If not open yet, resubscribeAll() on the open event handles it
    }

    return () => {
      const listeners = tableListeners.get(table);
      if (!listeners) return;
      listeners.delete(callback);
      if (listeners.size === 0) {
        tableListeners.delete(table);
        send({ type: "unsubscribe:table", table });
      }
    };
  }

  function channel(channelName: string): ChannelClient {
    if (channelObjects.has(channelName)) {
      return channelObjects.get(channelName)!;
    }

    const broadcastListeners: Map<string, Set<(payload: unknown) => void>> = new Map();
    let presenceCallback: ((event: PresenceEvent) => void) | null = null;
    let isSubscribed = false;
    let isTracked = false;
    let trackMeta: Record<string, unknown> = {};

    function sendWhenReady(msg: unknown) {
      connect();
      if (ws?.readyState === WebSocket.OPEN) {
        send(msg);
      } else if (ws) {
        ws.addEventListener("open", () => send(msg), { once: true });
      }
    }

    const channelClient: InternalChannelClient = {
      on(event: string, callback: (payload: unknown) => void) {
        if (!broadcastListeners.has(event)) broadcastListeners.set(event, new Set());
        broadcastListeners.get(event)?.add(callback);
        return channelClient;
      },

      subscribe() {
        isSubscribed = true;
        sendWhenReady({ type: "subscribe:broadcast", channel: channelName });
        return channelClient;
      },

      broadcast(event: string, payload: unknown) {
        sendWhenReady({ type: "broadcast", channel: channelName, event, payload });
      },

      unsubscribe() {
        isSubscribed = false;
        isTracked = false;
        send({ type: "unsubscribe:broadcast", channel: channelName });
        send({ type: "unsubscribe:presence", channel: channelName });
        channelObjects.delete(channelName);
      },

      onPresence(callback: (event: PresenceEvent) => void) {
        presenceCallback = callback;
        return channelClient;
      },

      track(meta?: Record<string, unknown>) {
        isTracked = true;
        trackMeta = meta ?? {};
        sendWhenReady({ type: "subscribe:presence", channel: channelName, meta: trackMeta });
        return channelClient;
      },

      untrack() {
        isTracked = false;
        send({ type: "unsubscribe:presence", channel: channelName });
      },

      _dispatchBroadcast(event: string, payload: unknown) {
        const listeners = broadcastListeners.get(event);
        if (listeners) {
          for (const cb of listeners) cb(payload);
        }
      },

      _dispatchPresence(msg: Record<string, unknown>) {
        if (presenceCallback) {
          const type = (msg.type as string).replace("presence:", "") as any;
          presenceCallback({ ...msg, type } as PresenceEvent);
        }
      },

      _resubscribe() {
        if (isSubscribed) send({ type: "subscribe:broadcast", channel: channelName });
        if (isTracked) send({ type: "subscribe:presence", channel: channelName, meta: trackMeta });
      },
    };

    channelObjects.set(channelName, channelClient);
    return channelClient;
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    tableListeners.clear();
    channelObjects.clear();
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  }

  return { subscribe, channel, disconnect };
}
