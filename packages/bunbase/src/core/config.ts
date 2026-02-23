/**
 * BunBase configuration types and resolution helpers.
 * @module
 */

/** OAuth client credentials for built-in providers. */
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

// Re-exported for consumers who need the full custom provider config type
export type { CustomOAuthProviderConfig } from "../auth/oauth/types.ts";

export interface DatabaseConfig {
  driver: "sqlite" | "postgres" | "mysql";
  url?: string; // connection string, e.g. "postgres://..." or "./data/db.sqlite"
  // SQLite-specific
  path?: string; // default ./data/db.sqlite (shorthand for url)
  // Postgres/MySQL-specific (alternative to url)
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  dbName?: string;
}

export interface BunBaseConfig {
  auth?: {
    tokenExpiry?: number; // session TTL in seconds, default 30 days
    email?: {
      webhook?: string;
    };
    oauth?: {
      redirectUrl?: string; // required in production
      google?: OAuthProviderConfig;
      github?: OAuthProviderConfig;
      discord?: OAuthProviderConfig;
      /** Custom OAuth providers keyed by a unique provider name. */
      providers?: Record<string, import("../auth/oauth/types.ts").CustomOAuthProviderConfig>;
    };
    apiKeys?: {
      /** Default TTL for new keys in days. 0 = infinite by default. Default: 365. */
      defaultExpirationDays?: number;
      /** Hard cap on TTL. Keys cannot be created with a longer TTL. null = no cap. */
      maxExpirationDays?: number;
    };
  };
  storage?: {
    driver?: "local" | "s3";
    localPath?: string; // default ./data/uploads
    s3?: {
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      endpoint?: string;
    };
    maxFileSize?: number; // bytes, default 10MB
    allowedMimeTypes?: string[];
  };
  cors?: {
    origins?: string[]; // required in production
  };
  realtime?: {
    enabled?: boolean;
  };
  development?: boolean; // default: NODE_ENV !== 'production'
  database?: DatabaseConfig; // default: { driver: "sqlite", path: "./data/db.sqlite" }
  /** @deprecated Use `database.path` instead */
  dbPath?: string; // default ./data/db.sqlite
  migrationsPath?: string; // default ./drizzle
  /**
   * IPs of trusted reverse proxies (exact match only, no CIDR).
   * When a request arrives from one of these IPs, BunBase will trust the
   * X-Forwarded-For / X-Real-IP headers for rate limiting.
   * When unset, forwarded headers are ignored and the socket IP is used directly.
   * Example: ["127.0.0.1"] for a local nginx proxy.
   */
  trustedProxies?: string[];
  /**
   * Serve a single-page application (SPA) alongside the API.
   *
   * Pass a **statically-imported** HTML bundle — dynamic `import()` does not
   * trigger Bun's HTML bundler. The import must be at the top level of your
   * entry file.
   *
   * @example
   * ```ts
   * import indexHtml from "./frontend/index.html";
   * createServer({ schema, config: defineConfig({ frontend: { html: indexHtml } }) });
   * ```
   */
  frontend?: {
    /** Result of `import x from "./index.html"` — passed directly to Bun.serve routes. */
    html: unknown;
  };
}

/**
 * Define BunBase config with full type checking.
 *
 * @param config User config.
 * @returns The same config object.
 */
export function defineConfig(config: BunBaseConfig): BunBaseConfig {
  return config;
}

/** Normalized database configuration used at runtime. */
export interface ResolvedDatabaseConfig {
  driver: "sqlite" | "postgres" | "mysql";
  url: string; // normalized connection string
}

/** Fully-resolved BunBase runtime configuration with defaults applied. */
export interface ResolvedConfig {
  auth: {
    tokenExpiry: number;
    email?: {
      webhook?: string;
    };
    oauth?: {
      redirectUrl?: string;
      google?: OAuthProviderConfig;
      github?: OAuthProviderConfig;
      discord?: OAuthProviderConfig;
      providers?: Record<string, import("../auth/oauth/types.ts").CustomOAuthProviderConfig>;
    };
    apiKeys: {
      /** Default TTL in days. 0 = new keys are infinite by default. */
      defaultExpirationDays: number;
      /** Hard cap in days. undefined = no cap. */
      maxExpirationDays: number | undefined;
    };
  };
  storage: {
    driver: "local" | "s3";
    localPath: string;
    s3?: {
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      endpoint?: string;
    };
    maxFileSize: number;
    allowedMimeTypes?: string[];
  };
  cors: {
    origins: string[];
  };
  realtime: {
    enabled: boolean;
  };
  development: boolean;
  database: ResolvedDatabaseConfig;
  /** @deprecated Use `database.url` for SQLite path */
  dbPath: string;
  migrationsPath: string;
  trustedProxies: string[];
  /** Present only when the user configured SPA serving. */
  frontend?: {
    html: unknown;
  };
}

function resolveDatabaseConfig(config?: BunBaseConfig): ResolvedDatabaseConfig {
  // Explicit database config takes priority
  if (config?.database) {
    const db = config.database;
    if (db.driver === "postgres") {
      const url =
        db.url ??
        (db.host
          ? `postgres://${db.user ?? ""}${db.password ? `:${db.password}` : ""}${db.user || db.password ? "@" : ""}${db.host}:${db.port ?? 5432}/${db.dbName ?? ""}`
          : "");
      if (!url) {
        throw new Error("BunBase: database.url or database.host is required for Postgres");
      }
      return { driver: "postgres", url };
    }
    if (db.driver === "mysql") {
      const url =
        db.url ??
        (db.host
          ? `mysql://${db.user ?? "root"}${db.password ? `:${db.password}` : ""}@${db.host}:${db.port ?? 3306}/${db.dbName ?? ""}`
          : "");
      if (!url) {
        throw new Error("BunBase: database.url or database.host is required for MySQL");
      }
      return { driver: "mysql", url };
    }
    // SQLite
    return { driver: "sqlite", url: db.url ?? db.path ?? "./data/db.sqlite" };
  }

  // Legacy dbPath support
  return { driver: "sqlite", url: config?.dbPath ?? "./data/db.sqlite" };
}

/**
 * Resolve user config into BunBase runtime config.
 *
 * @param config Optional partial config.
 * @returns Resolved config with defaults and production validations applied.
 *
 * @remarks
 * Defaults:
 * - `auth.tokenExpiry`: 30 days
 * - `auth.apiKeys.defaultExpirationDays`: 365
 * - `auth.apiKeys.maxExpirationDays`: `undefined`
 * - `storage.maxFileSize`: 10MB
 */
export function resolveConfig(config?: BunBaseConfig): ResolvedConfig {
  const isDev = config?.development ?? process.env.NODE_ENV !== "production";
  const database = resolveDatabaseConfig(config);

  // Validate and resolve apiKeys config
  const rawApiKeys = config?.auth?.apiKeys;
  const defaultExpirationDays = rawApiKeys?.defaultExpirationDays ?? 365;
  const maxExpirationDays = rawApiKeys?.maxExpirationDays ?? undefined;

  if (rawApiKeys?.defaultExpirationDays !== undefined && defaultExpirationDays < 0) {
    throw new Error("BunBase: auth.apiKeys.defaultExpirationDays must be >= 0");
  }
  if (maxExpirationDays !== undefined && maxExpirationDays < 1) {
    throw new Error("BunBase: auth.apiKeys.maxExpirationDays must be >= 1");
  }
  if (
    maxExpirationDays !== undefined &&
    defaultExpirationDays > 0 &&
    defaultExpirationDays > maxExpirationDays
  ) {
    throw new Error(
      `BunBase: auth.apiKeys.defaultExpirationDays (${defaultExpirationDays}) cannot exceed maxExpirationDays (${maxExpirationDays})`,
    );
  }

  const resolved: ResolvedConfig = {
    auth: {
      tokenExpiry: config?.auth?.tokenExpiry ?? 30 * 24 * 60 * 60, // 30 days
      email: config?.auth?.email,
      oauth: config?.auth?.oauth,
      apiKeys: { defaultExpirationDays, maxExpirationDays },
    },
    storage: {
      driver: config?.storage?.driver ?? "local",
      localPath: config?.storage?.localPath ?? "./data/uploads",
      s3: config?.storage?.s3,
      maxFileSize: config?.storage?.maxFileSize ?? 10 * 1024 * 1024, // 10MB
      allowedMimeTypes: config?.storage?.allowedMimeTypes,
    },
    cors: {
      origins: config?.cors?.origins ?? [],
    },
    realtime: {
      enabled: config?.realtime?.enabled ?? false,
    },
    development: isDev,
    database,
    dbPath: database.url,
    migrationsPath: config?.migrationsPath ?? "./drizzle",
    trustedProxies: config?.trustedProxies ?? [],
    frontend: config?.frontend,
  };

  if (!isDev) {
    if (
      resolved.auth.oauth &&
      (resolved.auth.oauth.google ||
        resolved.auth.oauth.github ||
        resolved.auth.oauth.discord ||
        (resolved.auth.oauth.providers && Object.keys(resolved.auth.oauth.providers).length > 0)) &&
      !resolved.auth.oauth.redirectUrl
    ) {
      throw new Error("BunBase: auth.oauth.redirectUrl is required in production");
    }

    if (resolved.cors.origins.length === 0) {
      throw new Error("BunBase: cors.origins is required in production");
    }
  }

  return resolved;
}
