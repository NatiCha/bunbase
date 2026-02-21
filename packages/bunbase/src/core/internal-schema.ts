import { sqliteTable, text as sqliteText, integer as sqliteInteger } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint } from "drizzle-orm/pg-core";
import { mysqlTable, text as mysqlText, int as mysqlInt, bigint as mysqlBigint } from "drizzle-orm/mysql-core";
import type { Dialect } from "./db-types.ts";

// ─── SQLite Variants ───

export const sqliteSessions = sqliteTable("_sessions", {
  id: sqliteText("id").primaryKey(),
  userId: sqliteText("user_id").notNull(),
  expiresAt: sqliteInteger("expires_at").notNull(),
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

// ─── Postgres Variants ───

export const pgSessions = pgTable("_sessions", {
  id: pgText("id").primaryKey(),
  userId: pgText("user_id").notNull(),
  expiresAt: pgBigint("expires_at", { mode: "number" }).notNull(),
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

// ─── MySQL Variants ───

export const mysqlSessions = mysqlTable("_sessions", {
  id: mysqlText("id").primaryKey(),
  userId: mysqlText("user_id").notNull(),
  expiresAt: mysqlBigint("expires_at", { mode: "number" }).notNull(),
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

// ─── Dialect-aware getter ───

export interface InternalSchema {
  sessions: typeof sqliteSessions | typeof pgSessions | typeof mysqlSessions;
  files: typeof sqliteFiles | typeof pgFiles | typeof mysqlFiles;
  verificationTokens: typeof sqliteVerificationTokens | typeof pgVerificationTokens | typeof mysqlVerificationTokens;
  oauthAccounts: typeof sqliteOauthAccounts | typeof pgOauthAccounts | typeof mysqlOauthAccounts;
  requestLogs: typeof sqliteRequestLogs | typeof pgRequestLogs | typeof mysqlRequestLogs;
}

export function getInternalSchema(dialect: Dialect): InternalSchema {
  if (dialect === "postgres") {
    return {
      sessions: pgSessions,
      files: pgFiles,
      verificationTokens: pgVerificationTokens,
      oauthAccounts: pgOauthAccounts,
      requestLogs: pgRequestLogs,
    };
  }
  if (dialect === "mysql") {
    return {
      sessions: mysqlSessions,
      files: mysqlFiles,
      verificationTokens: mysqlVerificationTokens,
      oauthAccounts: mysqlOauthAccounts,
      requestLogs: mysqlRequestLogs,
    };
  }
  return {
    sessions: sqliteSessions,
    files: sqliteFiles,
    verificationTokens: sqliteVerificationTokens,
    oauthAccounts: sqliteOauthAccounts,
    requestLogs: sqliteRequestLogs,
  };
}
