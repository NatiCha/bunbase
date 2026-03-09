/**
 * Canonical BunBase setup example:
 * schema -> rules -> createServer -> listen.
 */

import {
  createDevMailServer,
  createMailer,
  createServer,
  createSmtpTransport,
  defineConfig,
} from "bunbase";
import { customRoutes } from "./custom-routes";
import { rules } from "./rules";
import * as schema from "./schema";

const isDev = process.env.NODE_ENV !== "production";

if (isDev) {
  try {
    const devMail = createDevMailServer();
    console.log(`  Dev mail UI: ${devMail.url}`);
  } catch {
    console.warn("  Dev mail server could not start (ports 1025/1026 may be in use)");
  }
}

const mailer = createMailer({
  from: "Task Manager <noreply@tasks.local>",
  appUrl: process.env.APP_URL ?? (isDev ? "http://localhost:5173" : "http://localhost:3000"),
  transport: createSmtpTransport({
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? 1025),
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS! } }
      : {}),
  }),
});

const bunbase = createServer({
  schema,
  relations: schema.relations,
  rules,
  mailer,
  extend: customRoutes,
  config: defineConfig({
    development: isDev,
    cors: isDev ? { origins: ["http://localhost:5173"] } : undefined,
    realtime: { enabled: true },
  }),
});

bunbase.listen();
