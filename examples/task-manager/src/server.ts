import { createServer, defineConfig } from "tsbase";
import * as schema from "./schema";
import { rules } from "./rules";
import { customRouter } from "./custom-routes";

const isDev = process.env.NODE_ENV !== "production";

const tsbase = createServer({
  schema,
  rules,
  extend: customRouter,
  config: defineConfig({
    development: isDev,
    cors: isDev ? { origins: ["http://localhost:5173"] } : undefined,
  }),
});

export type AppRouter = typeof tsbase.appRouter;

tsbase.listen();
