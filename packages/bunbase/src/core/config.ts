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
      /**
       * Base URL of this BunBase server, used to build OAuth callback URLs.
       * Defaults to `http://localhost:3001` in development.
       * In production, set this to your BunBase server's public URL (e.g. `https://db.example.com`).
       */
      callbackBaseUrl?: string;
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
    emailVerification?: {
      /**
       * Automatically send a verification email when a new user registers, if
       * the users table has an `emailVerified` column and a mailer is configured.
       * Default: `true`.
       */
      autoSend?: boolean;
    };
    /** Multi-factor and passwordless authentication options. */
    mfa?: {
      /** Require all users to enroll in MFA. Default: false. */
      required?: boolean;
      /** AES-256 encryption key for TOTP secrets. Falls back to BUNBASE_MFA_SECRET env var. */
      encryptionKey?: string;
      totp?: {
        /** Enable TOTP-based 2FA. Default: false. */
        enabled?: boolean;
        /** App name shown in authenticator apps. Default: "BunBase". */
        issuer?: string;
        /** TOTP verification window (number of periods to check). Default: 1. */
        window?: number;
      };
      magicLink?: {
        /** Enable magic link passwordless login. Default: false. */
        enabled?: boolean;
        /** Token TTL in seconds. Default: 600 (10 minutes). */
        ttl?: number;
      };
      otp?: {
        /** Enable email OTP passwordless login. Default: false. */
        enabled?: boolean;
        /** Code TTL in seconds. Default: 300 (5 minutes). */
        ttl?: number;
        /** Number of digits in the OTP code. Default: 6. */
        length?: number;
      };
      passkeys?: {
        /** Enable WebAuthn/passkey authentication. Default: false. */
        enabled?: boolean;
        /** Relying party display name. */
        rpName?: string;
        /** Relying party ID (domain, e.g. "example.com"). */
        rpId?: string;
        /** Expected origin (e.g. "https://example.com"). */
        origin?: string;
        /**
         * Restrict passkeys to a specific authenticator type.
         * - `"platform"`: Only built-in authenticators (Touch ID, Face ID, Windows Hello, iCloud Keychain).
         *   Prevents QR code prompts for cross-device authentication.
         * - `"cross-platform"`: Only roaming authenticators (hardware security keys, phones via QR).
         * - `undefined`: Allow both (default browser behavior).
         */
        authenticatorAttachment?: "platform" | "cross-platform";
      };
      backupCodes?: {
        /** Number of backup codes to generate. Default: 10. */
        count?: number;
        /** Characters per backup code. Default: 8. */
        length?: number;
      };
      smsOtp?: {
        /** Enable SMS OTP login. Default: false. */
        enabled?: boolean;
        /** Code TTL in seconds. Default: 300. */
        ttl?: number;
        /** Number of digits. Default: 6. */
        length?: number;
      };
    };
    usernameLogin?: {
      /** Enable username-based login. Default: false. */
      enabled?: boolean;
      /** Column name in users table. Default: "username". */
      field?: string;
    };
    accountDeletion?: {
      /** Enable account deletion. Default: true. */
      enabled?: boolean;
      /** Require password confirmation. Default: true. */
      requirePassword?: boolean;
    };
    guestAuth?: {
      /** Enable anonymous/guest sessions. Default: false. */
      enabled?: boolean;
      /** Guest session TTL in seconds. Default: 86400 (24h). */
      ttl?: number;
    };
    invitations?: {
      /** Enable invitation system. Default: false. */
      enabled?: boolean;
      /** Require invite code for registration. Default: false. */
      required?: boolean;
      /** Invite TTL in seconds. Default: 604800 (7 days). */
      ttl?: number;
      /** Default max uses per invite. Default: 1. */
      maxUsesDefault?: number;
    };
    organizations?: {
      /** Enable organizations/teams. Default: false. */
      enabled?: boolean;
      /** Allowed roles. Default: ["owner", "admin", "member"]. */
      roles?: string[];
      /** Max orgs per user. Default: 10. */
      maxOrgsPerUser?: number;
      /** Org invite TTL in seconds. Default: 604800. */
      inviteTtl?: number;
    };
    jwt?: {
      /** Enable JWT mode instead of cookie sessions. Default: false. */
      enabled?: boolean;
      /** HMAC secret. Falls back to BUNBASE_JWT_SECRET env var. */
      secret?: string;
      /** Access token TTL in seconds. Default: 900 (15 min). */
      accessTokenTtl?: number;
      /** Refresh token TTL in seconds. Default: 604800 (7 days). */
      refreshTokenTtl?: number;
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
  /**
   * Domain for session and CSRF cookies.
   * Set to a dot-prefixed parent domain (e.g. `.example.com`) to share cookies
   * across subdomains (e.g. `app.example.com` and `api.example.com`).
   * When unset, cookies are scoped to the exact host that sets them.
   */
  cookieDomain?: string;
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
      callbackBaseUrl?: string;
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
    emailVerification: {
      /** Whether to auto-send a verification email on registration. */
      autoSend: boolean;
    };
    mfa: {
      required: boolean;
      encryptionKey: string | undefined;
      totp: {
        enabled: boolean;
        issuer: string;
        window: number;
      };
      magicLink: {
        enabled: boolean;
        ttl: number;
      };
      otp: {
        enabled: boolean;
        ttl: number;
        length: number;
      };
      passkeys: {
        enabled: boolean;
        rpName: string | undefined;
        rpId: string | undefined;
        origin: string | undefined;
        authenticatorAttachment: "platform" | "cross-platform" | undefined;
      };
      backupCodes: {
        count: number;
        length: number;
      };
      smsOtp: {
        enabled: boolean;
        ttl: number;
        length: number;
      };
    };
    usernameLogin: {
      enabled: boolean;
      field: string;
    };
    accountDeletion: {
      enabled: boolean;
      requirePassword: boolean;
    };
    guestAuth: {
      enabled: boolean;
      ttl: number;
    };
    invitations: {
      enabled: boolean;
      required: boolean;
      ttl: number;
      maxUsesDefault: number;
    };
    organizations: {
      enabled: boolean;
      roles: string[];
      maxOrgsPerUser: number;
      inviteTtl: number;
    };
    jwt: {
      enabled: boolean;
      secret: string | undefined;
      accessTokenTtl: number;
      refreshTokenTtl: number;
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
  /** Domain for session and CSRF cookies. */
  cookieDomain?: string;
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

  // Validate cookieDomain — reject values that could inject into Set-Cookie header
  const cookieDomain = config?.cookieDomain;
  if (cookieDomain !== undefined) {
    if (/[\s\r\n;]/.test(cookieDomain)) {
      throw new Error(
        'BunBase: cookieDomain contains invalid characters. Use a dot-prefixed hostname like ".example.com".',
      );
    }
  }

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
      emailVerification: {
        autoSend: config?.auth?.emailVerification?.autoSend ?? true,
      },
      mfa: {
        required: config?.auth?.mfa?.required ?? false,
        encryptionKey: config?.auth?.mfa?.encryptionKey,
        totp: {
          enabled: config?.auth?.mfa?.totp?.enabled ?? false,
          issuer: config?.auth?.mfa?.totp?.issuer ?? "BunBase",
          window: config?.auth?.mfa?.totp?.window ?? 1,
        },
        magicLink: {
          enabled: config?.auth?.mfa?.magicLink?.enabled ?? false,
          ttl: config?.auth?.mfa?.magicLink?.ttl ?? 600,
        },
        otp: {
          enabled: config?.auth?.mfa?.otp?.enabled ?? false,
          ttl: config?.auth?.mfa?.otp?.ttl ?? 300,
          length: config?.auth?.mfa?.otp?.length ?? 6,
        },
        passkeys: {
          enabled: config?.auth?.mfa?.passkeys?.enabled ?? false,
          rpName: config?.auth?.mfa?.passkeys?.rpName,
          rpId: config?.auth?.mfa?.passkeys?.rpId,
          origin: config?.auth?.mfa?.passkeys?.origin,
          authenticatorAttachment: config?.auth?.mfa?.passkeys?.authenticatorAttachment,
        },
        backupCodes: {
          count: config?.auth?.mfa?.backupCodes?.count ?? 10,
          length: config?.auth?.mfa?.backupCodes?.length ?? 8,
        },
        smsOtp: {
          enabled: config?.auth?.mfa?.smsOtp?.enabled ?? false,
          ttl: config?.auth?.mfa?.smsOtp?.ttl ?? 300,
          length: config?.auth?.mfa?.smsOtp?.length ?? 6,
        },
      },
      usernameLogin: {
        enabled: config?.auth?.usernameLogin?.enabled ?? false,
        field: config?.auth?.usernameLogin?.field ?? "username",
      },
      accountDeletion: {
        enabled: config?.auth?.accountDeletion?.enabled ?? true,
        requirePassword: config?.auth?.accountDeletion?.requirePassword ?? true,
      },
      guestAuth: {
        enabled: config?.auth?.guestAuth?.enabled ?? false,
        ttl: config?.auth?.guestAuth?.ttl ?? 86400,
      },
      invitations: {
        enabled: config?.auth?.invitations?.enabled ?? false,
        required: config?.auth?.invitations?.required ?? false,
        ttl: config?.auth?.invitations?.ttl ?? 604800,
        maxUsesDefault: config?.auth?.invitations?.maxUsesDefault ?? 1,
      },
      organizations: {
        enabled: config?.auth?.organizations?.enabled ?? false,
        roles: config?.auth?.organizations?.roles ?? ["owner", "admin", "member"],
        maxOrgsPerUser: config?.auth?.organizations?.maxOrgsPerUser ?? 10,
        inviteTtl: config?.auth?.organizations?.inviteTtl ?? 604800,
      },
      jwt: {
        enabled: config?.auth?.jwt?.enabled ?? false,
        secret: config?.auth?.jwt?.secret ?? process.env.BUNBASE_JWT_SECRET,
        accessTokenTtl: config?.auth?.jwt?.accessTokenTtl ?? 900,
        refreshTokenTtl: config?.auth?.jwt?.refreshTokenTtl ?? 604800,
      },
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
    cookieDomain: config?.cookieDomain,
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

    if (resolved.auth.jwt.enabled && !resolved.auth.jwt.secret) {
      throw new Error(
        "BunBase: auth.jwt.secret or BUNBASE_JWT_SECRET env var is required when JWT mode is enabled in production",
      );
    }
  }

  return resolved;
}
