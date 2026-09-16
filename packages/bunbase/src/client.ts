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
  /** Include the total number of authorized, filtered records. */
  count?: boolean;
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
  total?: number;
}

/** Successful authentication or a pending second-factor challenge. */
export type AuthResult =
  | { user: Record<string, unknown> }
  | { mfaRequired: true; mfaMethods: string[] };

export type AccountDeletionConfirmation =
  | { password: string; confirmEmail?: never }
  | { confirmEmail: string; password?: never };

type ExpandKeys<TSelect> = Extract<keyof TSelect, string>;

export interface TableClient<
  TSelect,
  TInsert,
  TExpand extends string = ExpandKeys<TSelect> | string,
> {
  list(params?: ListParams<TExpand>): Promise<ListResponse<TSelect>>;
  /**
   * Fetch all matching records by following cursor pages of up to 100 records.
   * Preserves filter/sort/expand params on every request. Rejects if any page
   * fails or pagination cannot advance, rather than returning partial results.
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

/** Fields assigned by server hooks and excluded from client write inputs.
 * This describes the API contract; enforce it with server-side field policies.
 */
export type ServerFields<S> = {
  [K in TableKeys<S>]?: S[K] extends Table ? readonly (keyof InferInsertModel<S[K]>)[] : never;
};

export type ClientInsert<T extends Table, Fields> = Omit<
  InferInsertModel<T>,
  Fields extends readonly (infer Key)[] ? Extract<Key, keyof InferInsertModel<T>> : never
>;

export type BunBaseAPI<S, F extends ServerFields<S> = Record<never, never>> = {
  [K in TableKeys<S>]: S[K] extends Table
    ? TableClient<InferSelectModel<S[K]>, ClientInsert<S[K], K extends keyof F ? F[K] : never>>
    : never;
};

// ─── Client options ───────────────────────────────────────────────────────────

/** Connection status of the realtime WebSocket client. */
export type RealtimeStatus = "connecting" | "open" | "closed" | "reconnecting";

export interface RealtimeOptions {
  /** Fired whenever the realtime connection status changes. */
  onStatusChange?: (status: RealtimeStatus) => void;
  /** Initial reconnect delay in ms before exponential backoff (default 500). */
  reconnectBaseDelayMs?: number;
  /** Maximum reconnect delay in ms after backoff (default 30_000). */
  reconnectMaxDelayMs?: number;
}

interface BunBaseClientOptions {
  url: string;
  /** Bearer API key for server-side / CLI usage. When set, cookies and CSRF are omitted. */
  apiKey?: string;
  /** Realtime WebSocket tuning (backoff, status callback). */
  realtime?: RealtimeOptions;
}

/**
 * Error thrown by every client method when the server responds with a
 * non-2xx status. Carries the structured error envelope returned by BunBase
 * (`code`, `message`) plus the HTTP `status` and any field-level errors.
 */
export class BunBaseClientError extends Error {
  /** Machine-readable error code from the server (e.g. `UNAUTHORIZED`). */
  readonly code?: BunBaseErrorCode | string;
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Field-level validation errors, when the server returns them. */
  readonly fields?: Record<string, string>;

  constructor(
    message: string,
    opts: {
      code?: BunBaseErrorCode | string;
      status: number;
      fields?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = "BunBaseClientError";
    this.code = opts.code;
    this.status = opts.status;
    this.fields = opts.fields;
  }
}

// ─── CSRF helper ──────────────────────────────────────────────────────────────

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.split(";").find((c) => c.trim().startsWith("csrf_token="));
  return match?.split("=")[1]?.trim() ?? "";
}

async function throwApiError(res: Response, fallback: string): Promise<never> {
  const parsed = await res.json().catch(() => ({}) as Partial<BunBaseErrorEnvelope>);
  const errObj = (
    parsed as Partial<BunBaseErrorEnvelope> & {
      error?: { fields?: Record<string, string> };
    }
  )?.error;
  const message = errObj?.message ?? fallback;
  throw new BunBaseClientError(message, {
    code: errObj?.code,
    status: res.status,
    fields: errObj?.fields,
  });
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
export function createBunBaseClient<
  S extends Record<string, unknown>,
  const F extends ServerFields<S> = Record<never, never>,
>(options: BunBaseClientOptions & { schema: S; serverFields?: F }) {
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

  /** Headers for a non-GET request with no JSON body (logout, delete, etc.). */
  function csrfHeaders(): HeadersInit {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : { "X-CSRF-Token": getCsrfToken() };
  }

  /**
   * Single fetch helper that every method routes through. Throws a
   * {@link BunBaseClientError} on any non-2xx response so callers never
   * receive an error envelope typed as a success shape.
   *
   * Pass `notFoundAsNull: true` to map a 404 to `null` instead of throwing
   * (used by `get`/`update`).
   */
  async function request<T>(
    path: string,
    init: RequestInit & { fallbackMessage?: string; notFoundAsNull?: boolean } = {},
  ): Promise<T> {
    const { fallbackMessage, notFoundAsNull, ...rest } = init;
    const res = await fetch(`${baseUrl}${path}`, { credentials, ...rest });
    if (notFoundAsNull && res.status === 404) return null as T;
    if (!res.ok) await throwApiError(res, fallbackMessage ?? "Request failed");
    // Some endpoints (rare) return an empty body; guard against JSON parse errors.
    return (await res.json().catch(() => ({}))) as T;
  }

  // ─── Auth state subscription ────────────────────────────────────────────────
  // In-memory listener set fired after a successful login/logout/register so
  // consumers can react to auth changes (mirrors Supabase/Firebase ergonomics).
  type AuthState = { user: Record<string, unknown> } | { user: null };
  const authListeners = new Set<(state: AuthState) => void>();
  function emitAuthState(state: AuthState) {
    for (const cb of authListeners) {
      try {
        cb(state);
      } catch {
        // Never let a listener error break the auth flow.
      }
    }
  }

  // Proxy-based API client: client.api.tableName.list() etc.
  const api = new Proxy({} as BunBaseAPI<S, F>, {
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
          if (params?.count !== undefined) url.searchParams.set("count", String(params.count));
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
          const records: unknown[] = [];
          const seenCursors = new Set<string>();
          let cursor: string | undefined;
          for (;;) {
            const page = await tableClient.list({ ...params, limit: 100, cursor });
            if (!page || !Array.isArray(page.data)) {
              throw new Error("Invalid BunBase list response");
            }
            for (const record of page.data) records.push(record);
            if (!page.hasMore) return records;
            const nextCursor = page.nextCursor;
            if (typeof nextCursor !== "string" || !nextCursor || seenCursors.has(nextCursor)) {
              throw new Error("BunBase pagination did not advance");
            }
            seenCursors.add(nextCursor);
            cursor = nextCursor;
          }
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
      const result = await request<{ user: Record<string, unknown> }>("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        fallbackMessage: "Registration failed",
      });
      emitAuthState({ user: result.user });
      return result;
    },

    /**
     * Log in with email/username + password.
     *
     * Resolves to `{ user }` on success, or `{ mfaRequired: true, mfaMethods }`
     * when the account has MFA enrolled and a second factor is still required.
     * Throws {@link BunBaseClientError} on bad credentials or other errors.
     */
    async login(data: {
      email?: string;
      username?: string;
      identifier?: string;
      password: string;
    }): Promise<AuthResult> {
      const result = await request<AuthResult>("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        fallbackMessage: "Login failed",
      });
      // Only emit a logged-in state once MFA (if any) is satisfied.
      if ("user" in result) emitAuthState({ user: result.user });
      return result;
    },

    async logout() {
      const result = await request<{ success: boolean }>("/auth/logout", {
        method: "POST",
        headers: csrfHeaders(),
        fallbackMessage: "Logout failed",
      });
      emitAuthState({ user: null });
      return result;
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

    /**
     * Subscribe to auth state changes triggered through this client
     * (login / register / logout). Returns an unsubscribe function.
     *
     * Note: this only fires for actions performed via this client instance —
     * it is not a server-pushed session watcher.
     */
    onAuthStateChange(cb: (state: { user: Record<string, unknown> | null }) => void): () => void {
      authListeners.add(cb as (s: AuthState) => void);
      return () => authListeners.delete(cb as (s: AuthState) => void);
    },

    async requestPasswordReset(email: string) {
      return request("/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        fallbackMessage: "Password reset request failed",
      });
    },

    async resetPassword(token: string, password: string) {
      return request("/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
        fallbackMessage: "Password reset failed",
      });
    },

    async verifyEmail(token: string) {
      return request("/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        fallbackMessage: "Email verification failed",
      });
    },

    async requestEmailVerification(email: string) {
      return request("/auth/request-email-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        fallbackMessage: "Email verification request failed",
      });
    },

    oauthUrl(provider: string) {
      return `${baseUrl}/auth/oauth/${provider}`;
    },

    // ─── Magic Links ───
    magicLink: {
      async request(email: string) {
        return request("/auth/magic-link/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
          fallbackMessage: "Magic link request failed",
        });
      },
      async verify(token: string) {
        const result = await request<AuthResult>("/auth/magic-link/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          fallbackMessage: "Magic link verification failed",
        });
        if ("user" in result) emitAuthState({ user: result.user });
        return result;
      },
    },

    // ─── Email OTP ───
    otp: {
      async request(email: string) {
        return request("/auth/otp/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
          fallbackMessage: "OTP request failed",
        });
      },
      async verify(email: string, code: string) {
        const result = await request<AuthResult>("/auth/otp/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
          fallbackMessage: "OTP verification failed",
        });
        if ("user" in result) emitAuthState({ user: result.user });
        return result;
      },
    },

    // ─── MFA / TOTP ───
    mfa: {
      async setup() {
        return request<{ secret: string; uri: string }>("/auth/mfa/totp/setup", {
          method: "POST",
          headers: mutationHeaders(),
          fallbackMessage: "MFA setup failed",
        });
      },
      async verifySetup(code: string) {
        return request<{ backupCodes: string[] }>("/auth/mfa/totp/verify-setup", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({ code }),
          fallbackMessage: "MFA setup verification failed",
        });
      },
      async verify(code: string) {
        const result = await request<{ user: Record<string, unknown> }>("/auth/mfa/totp/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
          fallbackMessage: "MFA verification failed",
        });
        if (result?.user) emitAuthState({ user: result.user });
        return result;
      },
      async disable(password: string) {
        return request<{ success: boolean }>("/auth/mfa/totp/disable", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({ password }),
          fallbackMessage: "MFA disable failed",
        });
      },
      async verifyBackup(code: string) {
        const result = await request<{ user: Record<string, unknown> }>("/auth/mfa/backup/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
          fallbackMessage: "Backup code verification failed",
        });
        if (result?.user) emitAuthState({ user: result.user });
        return result;
      },
      async regenerateBackup(password: string) {
        return request<{ backupCodes: string[] }>("/auth/mfa/backup/regenerate", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({ password }),
          fallbackMessage: "Backup code regeneration failed",
        });
      },
      async status() {
        return request<{ totp: boolean; passkeys: number }>("/auth/mfa/status", {
          headers: authHeaders(),
          fallbackMessage: "MFA status failed",
        });
      },
    },

    // ─── Passkeys ───
    passkeys: {
      async registerOptions() {
        return request("/auth/passkeys/register/options", {
          method: "POST",
          headers: mutationHeaders(),
          fallbackMessage: "Passkey register options failed",
        });
      },
      async registerVerify(attestation: Record<string, unknown>, name?: string) {
        return request<{ verified: boolean; credentialId: string }>(
          "/auth/passkeys/register/verify",
          {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify({ response: attestation, name }),
            fallbackMessage: "Passkey registration failed",
          },
        );
      },
      async loginOptions(email?: string) {
        return request("/auth/passkeys/login/options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
          fallbackMessage: "Passkey login options failed",
        });
      },
      async loginVerify(assertion: Record<string, unknown>) {
        const result = await request<{ user: Record<string, unknown> }>(
          "/auth/passkeys/login/verify",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(assertion),
            fallbackMessage: "Passkey login failed",
          },
        );
        if (result?.user) emitAuthState({ user: result.user });
        return result;
      },
      async list() {
        return request<{
          passkeys: Array<{
            id: string;
            name: string;
            deviceType: string;
            backedUp: number;
            createdAt: string;
            lastUsedAt: string | null;
          }>;
        }>("/auth/passkeys", {
          headers: authHeaders(),
          fallbackMessage: "Passkey list failed",
        });
      },
      async remove(id: string) {
        return request<{ deleted: boolean }>("/auth/passkeys/delete", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({ id }),
          fallbackMessage: "Passkey removal failed",
        });
      },
    },

    // ─── Sessions ───
    sessions: {
      async list() {
        return request<{
          sessions: Array<{
            id: string;
            createdAt: string;
            expiresAt: number;
            userAgent: string | null;
            ipAddress: string | null;
            current: boolean;
          }>;
        }>("/auth/sessions", {
          headers: authHeaders(),
          fallbackMessage: "Session list failed",
        });
      },
      async revoke(id: string) {
        return request<{ revoked: boolean }>(`/auth/sessions/${id}`, {
          method: "DELETE",
          headers: csrfHeaders(),
          fallbackMessage: "Session revoke failed",
        });
      },
      async revokeOthers() {
        return request<{ revokedCount: number }>("/auth/sessions/revoke-others", {
          method: "POST",
          headers: mutationHeaders(),
          fallbackMessage: "Session revoke failed",
        });
      },
    },

    // ─── Account Deletion ───
    async deleteAccount(confirmation?: string | AccountDeletionConfirmation) {
      const result = await request<{ deleted: boolean }>("/auth/delete-account", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify(
          typeof confirmation === "string" ? { password: confirmation } : (confirmation ?? {}),
        ),
        fallbackMessage: "Account deletion failed",
      });
      emitAuthState({ user: null });
      return result;
    },

    // ─── Guest Auth ───
    guest: {
      async create() {
        return request<{ guestId: string }>("/auth/guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          fallbackMessage: "Guest creation failed",
        });
      },
      async convert(data: { email: string; password: string }) {
        const result = await request<{ user: Record<string, unknown> }>("/auth/guest/convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          fallbackMessage: "Guest conversion failed",
        });
        if (result?.user) emitAuthState({ user: result.user });
        return result;
      },
    },

    // ─── SMS OTP ───
    smsOtp: {
      async request(phone: string) {
        return request("/auth/sms-otp/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone }),
          fallbackMessage: "SMS OTP request failed",
        });
      },
      async verify(phone: string, code: string) {
        const result = await request<AuthResult>("/auth/sms-otp/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, code }),
          fallbackMessage: "SMS OTP verification failed",
        });
        if ("user" in result) emitAuthState({ user: result.user });
        return result;
      },
    },

    // ─── Invitations ───
    invites: {
      async create(data: { email?: string; role?: string; maxUses?: number }) {
        return request<{ invite: Record<string, unknown> }>("/auth/invites", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify(data),
          fallbackMessage: "Invite creation failed",
        });
      },
      async list() {
        return request<{ invites: Array<Record<string, unknown>> }>("/auth/invites", {
          headers: authHeaders(),
          fallbackMessage: "Invite list failed",
        });
      },
      async delete(id: string) {
        return request<{ deleted: boolean }>(`/auth/invites/${id}`, {
          method: "DELETE",
          headers: csrfHeaders(),
          fallbackMessage: "Invite deletion failed",
        });
      },
      async validate(token: string) {
        return request<{ valid: boolean; email?: string }>("/auth/invites/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          fallbackMessage: "Invite validation failed",
        });
      },
    },

    // ─── Organizations ───
    organizations: {
      async create(data: { name: string; slug?: string }) {
        return request<{ organization: Record<string, unknown> }>("/auth/organizations", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify(data),
          fallbackMessage: "Organization creation failed",
        });
      },
      async list() {
        return request<{ organizations: Array<Record<string, unknown>> }>("/auth/organizations", {
          headers: authHeaders(),
          fallbackMessage: "Organization list failed",
        });
      },
      async get(id: string) {
        return request<{
          organization: Record<string, unknown>;
          members: Array<Record<string, unknown>>;
        }>(`/auth/organizations/${id}`, {
          headers: authHeaders(),
          fallbackMessage: "Organization fetch failed",
        });
      },
      async update(id: string, data: { name: string }) {
        return request<{ organization: Record<string, unknown> }>(`/auth/organizations/${id}`, {
          method: "PATCH",
          headers: mutationHeaders(),
          body: JSON.stringify(data),
          fallbackMessage: "Organization update failed",
        });
      },
      async delete(id: string) {
        return request<{ deleted: boolean }>(`/auth/organizations/${id}`, {
          method: "DELETE",
          headers: csrfHeaders(),
          fallbackMessage: "Organization deletion failed",
        });
      },
      async listMembers(orgId: string) {
        return request<{ members: Array<Record<string, unknown>> }>(
          `/auth/organizations/${orgId}/members`,
          {
            headers: authHeaders(),
            fallbackMessage: "Member list failed",
          },
        );
      },
      async updateMember(orgId: string, userId: string, data: { role: string }) {
        return request<{ member: Record<string, unknown> }>(
          `/auth/organizations/${orgId}/members/${userId}`,
          {
            method: "PATCH",
            headers: mutationHeaders(),
            body: JSON.stringify(data),
            fallbackMessage: "Member update failed",
          },
        );
      },
      async removeMember(orgId: string, userId: string) {
        return request<{ removed: boolean }>(`/auth/organizations/${orgId}/members/${userId}`, {
          method: "DELETE",
          headers: csrfHeaders(),
          fallbackMessage: "Member removal failed",
        });
      },
      async leave(orgId: string) {
        return request<{ left: boolean }>(`/auth/organizations/${orgId}/leave`, {
          method: "POST",
          headers: mutationHeaders(),
          fallbackMessage: "Leave organization failed",
        });
      },
      async invite(orgId: string, data: { email: string; role?: string }) {
        return request<{ invite: Record<string, unknown> }>(
          `/auth/organizations/${orgId}/invites`,
          {
            method: "POST",
            headers: mutationHeaders(),
            body: JSON.stringify(data),
            fallbackMessage: "Organization invite failed",
          },
        );
      },
      async listInvites(orgId: string) {
        return request<{ invites: Array<Record<string, unknown>> }>(
          `/auth/organizations/${orgId}/invites`,
          {
            headers: authHeaders(),
            fallbackMessage: "Organization invite list failed",
          },
        );
      },
      async deleteInvite(orgId: string, inviteId: string) {
        return request<{ deleted: boolean }>(`/auth/organizations/${orgId}/invites/${inviteId}`, {
          method: "DELETE",
          headers: csrfHeaders(),
          fallbackMessage: "Organization invite deletion failed",
        });
      },
      async acceptInvite(token: string) {
        return request<{ organization: Record<string, unknown> }>(
          "/auth/organization-invites/accept",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
            fallbackMessage: "Accept invite failed",
          },
        );
      },
    },

    // ─── JWT ───
    async refresh(refreshToken: string) {
      return request<{ accessToken: string; expiresIn: number }>("/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        fallbackMessage: "Token refresh failed",
      });
    },

    apiKeys: {
      async create(data: { name: string; expiresInDays?: number }) {
        return request<{
          id: string;
          name: string;
          keyPrefix: string;
          key: string;
          expiresAt: number | null;
          createdAt: string;
        }>("/auth/api-keys", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify(data),
          fallbackMessage: "API key creation failed",
        });
      },

      async list() {
        return request<
          Array<{
            id: string;
            userId: string;
            keyPrefix: string;
            name: string;
            expiresAt: number | null;
            lastUsedAt: string | null;
            createdAt: string;
          }>
        >("/auth/api-keys", {
          headers: authHeaders(),
          fallbackMessage: "API key list failed",
        });
      },

      async delete(id: string) {
        return request<{ deleted: boolean }>(`/auth/api-keys/${id}`, {
          method: "DELETE",
          headers: csrfHeaders(),
          fallbackMessage: "API key deletion failed",
        });
      },
    },
  };

  const files = {
    async upload(collection: string, recordId: string, file: File) {
      const formData = new FormData();
      formData.append("file", file);
      // The server requires the CSRF token on /files/* for cookie auth; send it
      // unless we're using bearer (API key) auth. Do NOT set Content-Type — the
      // browser sets the multipart boundary automatically for FormData bodies.
      const res = await fetch(`${baseUrl}/files/${collection}/${recordId}`, {
        method: "POST",
        credentials,
        headers: csrfHeaders(),
        body: formData,
      });
      if (!res.ok) await throwApiError(res, "Upload failed");
      return res.json();
    },

    downloadUrl(fileId: string) {
      return `${baseUrl}/files/${fileId}`;
    },

    async delete(fileId: string) {
      return request(`/files/${fileId}`, {
        method: "DELETE",
        headers: csrfHeaders(),
        fallbackMessage: "Delete failed",
      });
    },
  };

  const realtime = createRealtimeClient(baseUrl, apiKey, options.realtime);

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

function createRealtimeClient(baseUrl: string, apiKey?: string, opts?: RealtimeOptions) {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let currentStatus: RealtimeStatus = "closed";

  const baseDelay = opts?.reconnectBaseDelayMs ?? 500;
  const maxDelay = opts?.reconnectMaxDelayMs ?? 30_000;

  function setStatus(next: RealtimeStatus) {
    if (next === currentStatus) return;
    currentStatus = next;
    try {
      opts?.onStatusChange?.(next);
    } catch {
      // Never let a status listener error break the connection lifecycle.
    }
  }

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

  /**
   * Exponential backoff with full jitter, capped at `maxDelay`.
   * delay = random(0, min(maxDelay, baseDelay * 2^attempt))
   */
  function nextReconnectDelay(): number {
    const exp = Math.min(maxDelay, baseDelay * 2 ** reconnectAttempts);
    reconnectAttempts++;
    return Math.random() * exp;
  }

  function connect() {
    if (ws) return;
    setStatus(reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const wsUrl = `${baseUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws"))}/realtime`;
    // Bun's WebSocket supports custom headers for server-side bearer auth.
    // Browser WebSocket API does not, so the header is only passed when an apiKey
    // is configured (server-side/CLI usage). Browser clients use cookie-based WS auth.
    ws =
      apiKey && typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
        ? new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } } as any)
        : new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectAttempts = 0;
      setStatus("open");
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
        setStatus("reconnecting");
        reconnectTimer = setTimeout(() => {
          connect();
        }, nextReconnectDelay());
      } else {
        setStatus("closed");
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
    reconnectAttempts = 0;
    tableListeners.clear();
    channelObjects.clear();
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    setStatus("closed");
  }

  return {
    subscribe,
    channel,
    disconnect,
    /** Current connection status. */
    get status(): RealtimeStatus {
      return currentStatus;
    },
  };
}
