/**
 * Canonical BunBase setup example:
 * schema -> rules -> createServer -> listen.
 */
import { createServer, defineConfig } from "bunbase";
import type { ExtendContext } from "bunbase";
import * as schema from "./schema";
import { rules } from "./rules";
import { customRoutes } from "./custom-routes";

const isDev = process.env.NODE_ENV !== "production";

const bunbase = createServer({
  schema,
  rules,
  extend: customRoutes,
  config: defineConfig({
    development: isDev,
    cors: isDev ? { origins: ["http://localhost:5173"] } : undefined,
  }),
});

bunbase.listen();
