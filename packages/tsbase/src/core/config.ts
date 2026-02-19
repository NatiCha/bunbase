export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

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

export interface TSBaseConfig {
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
  development?: boolean; // default: NODE_ENV !== 'production'
  database?: DatabaseConfig; // default: { driver: "sqlite", path: "./data/db.sqlite" }
  /** @deprecated Use `database.path` instead */
  dbPath?: string; // default ./data/db.sqlite
  migrationsPath?: string; // default ./drizzle
}

export function defineConfig(config: TSBaseConfig): TSBaseConfig {
  return config;
}

export interface ResolvedDatabaseConfig {
  driver: "sqlite" | "postgres" | "mysql";
  url: string; // normalized connection string
}

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
  development: boolean;
  database: ResolvedDatabaseConfig;
  /** @deprecated Use `database.url` for SQLite path */
  dbPath: string;
  migrationsPath: string;
}

function resolveDatabaseConfig(config?: TSBaseConfig): ResolvedDatabaseConfig {
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
        throw new Error(
          "TSBase: database.url or database.host is required for Postgres",
        );
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
        throw new Error(
          "TSBase: database.url or database.host is required for MySQL",
        );
      }
      return { driver: "mysql", url };
    }
    // SQLite
    return { driver: "sqlite", url: db.url ?? db.path ?? "./data/db.sqlite" };
  }

  // Legacy dbPath support
  return { driver: "sqlite", url: config?.dbPath ?? "./data/db.sqlite" };
}

export function resolveConfig(config?: TSBaseConfig): ResolvedConfig {
  const isDev = config?.development ?? process.env.NODE_ENV !== "production";
  const database = resolveDatabaseConfig(config);

  const resolved: ResolvedConfig = {
    auth: {
      tokenExpiry: config?.auth?.tokenExpiry ?? 30 * 24 * 60 * 60, // 30 days
      email: config?.auth?.email,
      oauth: config?.auth?.oauth,
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
    development: isDev,
    database,
    dbPath: database.url,
    migrationsPath: config?.migrationsPath ?? "./drizzle",
  };

  if (!isDev) {
    if (
      resolved.auth.oauth &&
      (resolved.auth.oauth.google ||
        resolved.auth.oauth.github ||
        resolved.auth.oauth.discord) &&
      !resolved.auth.oauth.redirectUrl
    ) {
      throw new Error(
        "TSBase: auth.oauth.redirectUrl is required in production",
      );
    }

    if (resolved.cors.origins.length === 0) {
      throw new Error("TSBase: cors.origins is required in production");
    }
  }

  return resolved;
}
