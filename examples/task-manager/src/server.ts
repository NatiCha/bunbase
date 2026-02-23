/**
 * Canonical BunBase setup example:
 * schema -> rules -> createServer -> listen.
 */

import { createServer, defineConfig } from "bunbase";
import { customRoutes } from "./custom-routes";
import { rules } from "./rules";
import * as schema from "./schema";

const isDev = process.env.NODE_ENV !== "production";

const bunbase = createServer({
  schema,
  relations: schema.relations,
  rules,
  extend: customRoutes,
  config: defineConfig({
    development: isDev,
    cors: isDev ? { origins: ["http://localhost:5173"] } : undefined,
    realtime: { enabled: true },
  }),
});

bunbase.listen();
