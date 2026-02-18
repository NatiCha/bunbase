export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
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
  dbPath?: string; // default ./data/db.sqlite
  migrationsPath?: string; // default ./drizzle
}

export function defineConfig(config: TSBaseConfig): TSBaseConfig {
  return config;
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
  dbPath: string;
  migrationsPath: string;
}

export function resolveConfig(config?: TSBaseConfig): ResolvedConfig {
  const isDev = config?.development ?? process.env.NODE_ENV !== "production";

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
    dbPath: config?.dbPath ?? "./data/db.sqlite",
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
