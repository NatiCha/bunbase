import {
  bigint as mysqlBigint,
  char as mysqlChar,
  int as mysqlInt,
  mysqlTable,
  text as mysqlText,
} from "drizzle-orm/mysql-core";
import {
  bigint as pgBigint,
  integer as pgInteger,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import { integer as sqliteInteger, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core";
import type { Dialect } from "./db-types.ts";

// ─── SQLite Variants ───

export const sqliteSessions = sqliteTable("_sessions", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull(),
  expiresAt: sqliteInteger("expires_at").notNull(),
  mfaVerified: sqliteInteger("mfa_verified"),
  createdAt: sqliteText("created_at").notNull(),
});

export const sqliteFiles = sqliteTable("_files", {
  id: sqliteText("id").primaryKey(),
  collection: sqliteText("collection").notNull(),
  recordId: sqliteText("record_id").notNull(),
  filename: sqliteText("filename").notNull(),
  mimeType: sqliteText("mime_type").notNull(),
  size: sqliteInteger("size").notNull(),
  storagePath: sqliteText("storage_path").notNull(),
  createdAt: sqliteText("created_at").notNull(),
});

export const sqliteVerificationTokens = sqliteTable("_verification_tokens", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull(),
  tokenHash: sqliteText("token_hash").notNull(),
  type: sqliteText("type").notNull(),
  expiresAt: sqliteInteger("expires_at").notNull(),
  createdAt: sqliteText("created_at").notNull(),
});

export const sqliteOauthAccounts = sqliteTable("_oauth_accounts", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull(),
  provider: sqliteText("provider").notNull(),
  providerAccountId: sqliteText("provider_account_id").notNull(),
  createdAt: sqliteText("created_at").notNull(),
});

export const sqliteRequestLogs = sqliteTable("_request_logs", {
  id: sqliteText("id").primaryKey(),
  method: sqliteText("method").notNull(),
  path: sqliteText("path").notNull(),
  status: sqliteInteger("status").notNull(),
  durationMs: sqliteInteger("duration_ms").notNull(),
  userId: sqliteText("user_id"),
  timestamp: sqliteText("timestamp").notNull(),
});

export const sqliteApiKeys = sqliteTable("_api_keys", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull(),
  keyHash: sqliteText("key_hash").notNull(),
  keyPrefix: sqliteText("key_prefix").notNull(),
  name: sqliteText("name").notNull(),
  expiresAt: sqliteInteger("expires_at"),
  lastUsedAt: sqliteText("last_used_at"),
  createdAt: sqliteText("created_at").notNull(),
});

// ─── Postgres Variants ───

export const pgSessions = pgTable("_sessions", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull(),
  expiresAt: pgBigint("expires_at", { mode: "number" }).notNull(),
  mfaVerified: pgInteger("mfa_verified"),
  createdAt: pgText("created_at").notNull(),
});

export const pgFiles = pgTable("_files", {
  id: pgText("id").primaryKey(),
  collection: pgText("collection").notNull(),
  recordId: pgText("record_id").notNull(),
  filename: pgText("filename").notNull(),
  mimeType: pgText("mime_type").notNull(),
  size: pgInteger("size").notNull(),
  storagePath: pgText("storage_path").notNull(),
  createdAt: pgText("created_at").notNull(),
});

export const pgVerificationTokens = pgTable("_verification_tokens", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull(),
  tokenHash: pgText("token_hash").notNull(),
  type: pgText("type").notNull(),
  expiresAt: pgBigint("expires_at", { mode: "number" }).notNull(),
  createdAt: pgText("created_at").notNull(),
});

export const pgOauthAccounts = pgTable("_oauth_accounts", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull(),
  provider: pgText("provider").notNull(),
  providerAccountId: pgText("provider_account_id").notNull(),
  createdAt: pgText("created_at").notNull(),
});

export const pgRequestLogs = pgTable("_request_logs", {
  id: pgText("id").primaryKey(),
  method: pgText("method").notNull(),
  path: pgText("path").notNull(),
  status: pgInteger("status").notNull(),
  durationMs: pgInteger("duration_ms").notNull(),
  userId: pgText("user_id"),
  timestamp: pgText("timestamp").notNull(),
});

export const pgApiKeys = pgTable("_api_keys", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull(),
  keyHash: pgText("key_hash").notNull(),
  keyPrefix: pgText("key_prefix").notNull(),
  name: pgText("name").notNull(),
  expiresAt: pgBigint("expires_at", { mode: "number" }),
  lastUsedAt: pgText("last_used_at"),
  createdAt: pgText("created_at").notNull(),
});

// ─── MySQL Variants ───

export const mysqlSessions = mysqlTable("_sessions", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull(),
  expiresAt: mysqlBigint("expires_at", { mode: "number" }).notNull(),
  mfaVerified: mysqlInt("mfa_verified"),
  createdAt: mysqlText("created_at").notNull(),
});

export const mysqlFiles = mysqlTable("_files", {
  id: mysqlText("id").primaryKey(),
  collection: mysqlText("collection").notNull(),
  recordId: mysqlText("record_id").notNull(),
  filename: mysqlText("filename").notNull(),
  mimeType: mysqlText("mime_type").notNull(),
  size: mysqlInt("size").notNull(),
  storagePath: mysqlText("storage_path").notNull(),
  createdAt: mysqlText("created_at").notNull(),
});

export const mysqlVerificationTokens = mysqlTable("_verification_tokens", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull(),
  tokenHash: mysqlText("token_hash").notNull(),
  type: mysqlText("type").notNull(),
  expiresAt: mysqlBigint("expires_at", { mode: "number" }).notNull(),
  createdAt: mysqlText("created_at").notNull(),
});

export const mysqlOauthAccounts = mysqlTable("_oauth_accounts", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull(),
  provider: mysqlText("provider").notNull(),
  providerAccountId: mysqlText("provider_account_id").notNull(),
  createdAt: mysqlText("created_at").notNull(),
});

export const mysqlRequestLogs = mysqlTable("_request_logs", {
  id: mysqlText("id").primaryKey(),
  method: mysqlText("method").notNull(),
  path: mysqlText("path").notNull(),
  status: mysqlInt("status").notNull(),
  durationMs: mysqlInt("duration_ms").notNull(),
  userId: mysqlText("user_id"),
  timestamp: mysqlText("timestamp").notNull(),
});

export const mysqlApiKeys = mysqlTable("_api_keys", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull(),
  keyHash: mysqlChar("key_hash", { length: 64 }).notNull(),
  keyPrefix: mysqlText("key_prefix").notNull(),
  name: mysqlText("name").notNull(),
  expiresAt: mysqlBigint("expires_at", { mode: "number" }),
  lastUsedAt: mysqlText("last_used_at"),
  createdAt: mysqlText("created_at").notNull(),
});

// ─── MFA Tables: SQLite ───

export const sqliteMfaTotp = sqliteTable("_mfa_totp", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull().unique(),
  encryptedSecret: sqliteText("encrypted_secret").notNull(),
  verified: sqliteInteger("verified").notNull().default(0),
  createdAt: sqliteText("created_at").notNull(),
});

export const sqliteMfaBackupCodes = sqliteTable("_mfa_backup_codes", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull(),
  codeHash: sqliteText("code_hash").notNull(),
  used: sqliteInteger("used").notNull().default(0),
  createdAt: sqliteText("created_at").notNull(),
});

export const sqlitePasskeyCredentials = sqliteTable("_passkey_credentials", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull(),
  publicKey: sqliteText("public_key").notNull(),
  counter: sqliteInteger("counter").notNull().default(0),
  deviceType: sqliteText("device_type"),
  backedUp: sqliteInteger("backed_up").notNull().default(0),
  transports: sqliteText("transports"),
  name: sqliteText("name").notNull(),
  createdAt: sqliteText("created_at").notNull(),
  lastUsedAt: sqliteText("last_used_at"),
});

// ─── MFA Tables: Postgres ───

export const pgMfaTotp = pgTable("_mfa_totp", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull().unique(),
  encryptedSecret: pgText("encrypted_secret").notNull(),
  verified: pgInteger("verified").notNull().default(0),
  createdAt: pgText("created_at").notNull(),
});

export const pgMfaBackupCodes = pgTable("_mfa_backup_codes", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull(),
  codeHash: pgText("code_hash").notNull(),
  used: pgInteger("used").notNull().default(0),
  createdAt: pgText("created_at").notNull(),
});

export const pgPasskeyCredentials = pgTable("_passkey_credentials", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull(),
  publicKey: pgText("public_key").notNull(),
  counter: pgInteger("counter").notNull().default(0),
  deviceType: pgText("device_type"),
  backedUp: pgInteger("backed_up").notNull().default(0),
  transports: pgText("transports"),
  name: pgText("name").notNull(),
  createdAt: pgText("created_at").notNull(),
  lastUsedAt: pgText("last_used_at"),
});

// ─── MFA Tables: MySQL ───

export const mysqlMfaTotp = mysqlTable("_mfa_totp", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull().unique(),
  encryptedSecret: mysqlText("encrypted_secret").notNull(),
  verified: mysqlInt("verified").notNull().default(0),
  createdAt: mysqlText("created_at").notNull(),
});

export const mysqlMfaBackupCodes = mysqlTable("_mfa_backup_codes", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull(),
  codeHash: mysqlText("code_hash").notNull(),
  used: mysqlInt("used").notNull().default(0),
  createdAt: mysqlText("created_at").notNull(),
});

export const mysqlPasskeyCredentials = mysqlTable("_passkey_credentials", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull(),
  publicKey: mysqlText("public_key").notNull(),
  counter: mysqlInt("counter").notNull().default(0),
  deviceType: mysqlText("device_type"),
  backedUp: mysqlInt("backed_up").notNull().default(0),
  transports: mysqlText("transports"),
  name: mysqlText("name").notNull(),
  createdAt: mysqlText("created_at").notNull(),
  lastUsedAt: mysqlText("last_used_at"),
});

// ─── Dialect-aware getter ───

export interface InternalSchema {
  sessions: typeof sqliteSessions | typeof pgSessions | typeof mysqlSessions;
  files: typeof sqliteFiles | typeof pgFiles | typeof mysqlFiles;
  verificationTokens:
    | typeof sqliteVerificationTokens
    | typeof pgVerificationTokens
    | typeof mysqlVerificationTokens;
  oauthAccounts: typeof sqliteOauthAccounts | typeof pgOauthAccounts | typeof mysqlOauthAccounts;
  requestLogs: typeof sqliteRequestLogs | typeof pgRequestLogs | typeof mysqlRequestLogs;
  apiKeys: typeof sqliteApiKeys | typeof pgApiKeys | typeof mysqlApiKeys;
  mfaTotp: typeof sqliteMfaTotp | typeof pgMfaTotp | typeof mysqlMfaTotp;
  mfaBackupCodes:
    | typeof sqliteMfaBackupCodes
    | typeof pgMfaBackupCodes
    | typeof mysqlMfaBackupCodes;
  passkeyCredentials:
    | typeof sqlitePasskeyCredentials
    | typeof pgPasskeyCredentials
    | typeof mysqlPasskeyCredentials;
}

export function getInternalSchema(dialect: Dialect): InternalSchema {
  if (dialect === "postgres") {
    return {
      sessions: pgSessions,
      files: pgFiles,
      verificationTokens: pgVerificationTokens,
      oauthAccounts: pgOauthAccounts,
      requestLogs: pgRequestLogs,
      apiKeys: pgApiKeys,
      mfaTotp: pgMfaTotp,
      mfaBackupCodes: pgMfaBackupCodes,
      passkeyCredentials: pgPasskeyCredentials,
    };
  }
  if (dialect === "mysql") {
    return {
      sessions: mysqlSessions,
      files: mysqlFiles,
      verificationTokens: mysqlVerificationTokens,
      oauthAccounts: mysqlOauthAccounts,
      requestLogs: mysqlRequestLogs,
      apiKeys: mysqlApiKeys,
      mfaTotp: mysqlMfaTotp,
      mfaBackupCodes: mysqlMfaBackupCodes,
      passkeyCredentials: mysqlPasskeyCredentials,
    };
  }
  return {
    sessions: sqliteSessions,
    files: sqliteFiles,
    verificationTokens: sqliteVerificationTokens,
    oauthAccounts: sqliteOauthAccounts,
    requestLogs: sqliteRequestLogs,
    apiKeys: sqliteApiKeys,
    mfaTotp: sqliteMfaTotp,
    mfaBackupCodes: sqliteMfaBackupCodes,
    passkeyCredentials: sqlitePasskeyCredentials,
  };
}
