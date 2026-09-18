import { join } from "node:path";
import { createServer, defineRules } from "../../../src/index.ts";
import html from "./index.html";
import * as schema from "./schema.ts";

const work = process.env.BUNBASE_SMOKE_WORK!;
const origin = process.env.BUNBASE_SMOKE_ORIGIN!;
const server = createServer({
  schema,
  rules: defineRules({
    tasks: {
      list: ({ auth }) => auth !== null,
      get: ({ auth }) => auth !== null,
      create: ({ auth }) => auth !== null,
      update: ({ auth }) => auth !== null,
      delete: ({ auth }) => auth !== null,
    },
  }),
  config: {
    development: false,
    dbPath: join(work, "db.sqlite"),
    migrationsPath: join(import.meta.dir, "drizzle"),
    cors: { origins: [origin] },
    serviceKey: "production-smoke-test-only",
    frontend: { html },
    realtime: {
      enabled: true,
      authorize: ({ auth, kind, channel }) =>
        auth !== null && kind === "presence" && channel === "smoke-ready",
    },
    storage: { localPath: join(work, "uploads") },
  },
});
server.listen(Number(new URL(origin).port));
