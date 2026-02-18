import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const files = sqliteTable("_files", {
  id: text("id").primaryKey(),
  collection: text("collection").notNull(),
  recordId: text("record_id").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storage_path").notNull(),
  createdAt: text("created_at").notNull(),
});

export const verificationTokens = sqliteTable("_verification_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  type: text("type").notNull(), // 'email_verification' | 'password_reset'
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const oauthAccounts = sqliteTable("_oauth_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  createdAt: text("created_at").notNull(),
});
