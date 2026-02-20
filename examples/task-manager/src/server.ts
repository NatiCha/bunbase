import { createServer, defineConfig } from "tsbase";
import type { ExtendContext } from "tsbase";
import * as schema from "./schema";
import { rules } from "./rules";
import { customRoutes } from "./custom-routes";

const isDev = process.env.NODE_ENV !== "production";

const tsbase = createServer({
  schema,
  rules,
  extend: customRoutes,
  config: defineConfig({
    development: isDev,
    cors: isDev ? { origins: ["http://localhost:5173"] } : undefined,
  }),
});

tsbase.listen();
