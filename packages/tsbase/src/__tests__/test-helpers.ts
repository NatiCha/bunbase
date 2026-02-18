import type { ResolvedConfig } from "../core/config.ts";

export function makeResolvedConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  const authOverrides = (overrides.auth ?? {}) as Partial<ResolvedConfig["auth"]>;
  const storageOverrides =
    (overrides.storage ?? {}) as Partial<ResolvedConfig["storage"]>;
  const corsOverrides = (overrides.cors ?? {}) as Partial<ResolvedConfig["cors"]>;

  return {
    auth: {
      tokenExpiry: authOverrides.tokenExpiry ?? 60 * 60,
      email: authOverrides.email,
      oauth: authOverrides.oauth,
    },
    storage: {
      driver: storageOverrides.driver ?? "local",
      localPath: storageOverrides.localPath ?? "./data/uploads",
      s3: storageOverrides.s3,
      maxFileSize: storageOverrides.maxFileSize ?? 10 * 1024 * 1024,
      allowedMimeTypes: storageOverrides.allowedMimeTypes,
    },
    cors: {
      origins: corsOverrides.origins ?? [],
    },
    development: overrides.development ?? true,
    dbPath: overrides.dbPath ?? "./data/db.sqlite",
    migrationsPath: overrides.migrationsPath ?? "./drizzle",
  };
}
