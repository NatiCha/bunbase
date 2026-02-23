/**
 * Compile-checked BunBase documentation examples.
 *
 * This file is intentionally not imported by runtime code. It exists so AI tools
 * and editors can discover end-to-end usage patterns from the package alone.
 */
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createBunBaseClient } from "../client.ts";
import {
  authenticated,
  createServer,
  defineConfig,
  defineRelations,
  defineRules,
  type ExtendContext,
  ownerOnly,
  type RouteMap,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Shared schema used by examples
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  name: text("name"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("todo"),
  projectId: text("project_id").notNull(),
  ownerId: text("owner_id").notNull(),
});

export const schema = { users, projects, tasks };

export const relations = defineRelations(schema, (r) => ({
  tasks: {
    owner: r.one.users({
      from: r.tasks.ownerId,
      to: r.users.id,
    }),
    project: r.one.projects({
      from: r.tasks.projectId,
      to: r.projects.id,
    }),
  },
  projects: {
    tasks: r.many.tasks({
      from: r.projects.id,
      to: r.tasks.projectId,
    }),
  },
}));

export const rules = defineRules({
  users: {
    list: ({ auth }) => auth?.role === "admin",
    get: ({ auth }) => auth?.role === "admin",
  },
  projects: {
    list: () => null,
    get: () => null,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(projects.ownerId, auth),
    delete: ({ auth }) => ownerOnly(projects.ownerId, auth),
  },
  tasks: {
    list: ({ auth }) => (auth ? eq(tasks.ownerId, auth.id) : false),
    get: ({ auth }) => (auth ? eq(tasks.ownerId, auth.id) : false),
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(tasks.ownerId, auth),
    delete: ({ auth }) => ownerOnly(tasks.ownerId, auth),
  },
});

// ---------------------------------------------------------------------------
// 1) Full server setup: schema -> defineRules -> createServer
// ---------------------------------------------------------------------------

export function fullServerSetupExample() {
  return createServer({
    schema,
    relations,
    rules,
    extend: customRouteReadsAuthUserExample,
    config: defineConfig({
      development: true,
      cors: { origins: ["http://localhost:3000"] },
      realtime: { enabled: true },
      auth: {
        apiKeys: {
          defaultExpirationDays: 30,
          maxExpirationDays: 365,
        },
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// 2) Custom route that reads the authenticated user
// ---------------------------------------------------------------------------

export function customRouteReadsAuthUserExample({ extractAuth }: ExtendContext): RouteMap {
  return {
    "/api/me-summary": {
      GET: async (req: Request) => {
        const auth = await extractAuth(req);
        if (!auth) {
          return Response.json(
            { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
            { status: 401 },
          );
        }
        return Response.json({
          userId: auth.id,
          role: auth.role,
          email: auth.email,
        });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 3) List query with filters, pagination, and expand
// ---------------------------------------------------------------------------

export async function listWithFiltersPaginationExpandExample() {
  const client = createBunBaseClient<typeof schema>({
    url: "http://localhost:3000",
    schema,
  });

  const page1 = await client.api.tasks.list({
    filter: {
      status: { in: ["todo", "in_progress"] },
      title: { contains: "release" },
    },
    sort: "id",
    order: "asc",
    limit: 20,
    expand: ["owner", "project"],
  });

  if (!page1.hasMore || !page1.nextCursor) return page1;

  return client.api.tasks.list({
    cursor: page1.nextCursor,
    limit: 20,
    expand: ["owner", "project"],
  });
}

// ---------------------------------------------------------------------------
// 4) Create an API key and use it from a second client
// ---------------------------------------------------------------------------

export async function apiKeyCreateAndUseExample() {
  const sessionClient = createBunBaseClient<typeof schema>({
    url: "http://localhost:3000",
    schema,
  });

  const created = await sessionClient.auth.apiKeys.create({
    name: "ci-agent",
    expiresInDays: 30,
  });

  const apiKeyClient = createBunBaseClient<typeof schema>({
    url: "http://localhost:3000",
    apiKey: created.key,
    schema,
  });

  return apiKeyClient.api.tasks.list({ limit: 5 });
}

// ---------------------------------------------------------------------------
// 5) Realtime subscription on the client
// ---------------------------------------------------------------------------

export function realtimeSubscriptionExample() {
  const client = createBunBaseClient<typeof schema>({
    url: "http://localhost:3000",
    schema,
  });

  const unsubscribeTable = client.realtime.subscribe("tasks", (event) => {
    console.log("task event", event.action, event.id);
  });

  const channel = client.realtime
    .channel("project:alpha")
    .on("task:assigned", (payload) => {
      console.log("broadcast", payload);
    })
    .onPresence((presenceEvent) => {
      console.log("presence", presenceEvent.type, presenceEvent.channel);
    })
    .subscribe()
    .track({ screen: "dashboard" });

  return () => {
    unsubscribeTable();
    channel.untrack();
    channel.unsubscribe();
    client.realtime.disconnect();
  };
}

// ---------------------------------------------------------------------------
// 6) File upload and retrieval
// ---------------------------------------------------------------------------

export async function fileUploadAndRetrievalExample(file: File) {
  const client = createBunBaseClient<typeof schema>({
    url: "http://localhost:3000",
    schema,
  });

  const uploadResult = await client.files.upload("tasks", "task-123", file);
  const fileId =
    typeof uploadResult === "object" &&
    uploadResult !== null &&
    "file" in uploadResult &&
    typeof uploadResult.file === "object" &&
    uploadResult.file !== null &&
    "id" in uploadResult.file &&
    typeof uploadResult.file.id === "string"
      ? uploadResult.file.id
      : "";

  const downloadUrl = client.files.downloadUrl(fileId);
  const deleted = fileId ? await client.files.delete(fileId) : { deleted: false };

  return { uploadResult, downloadUrl, deleted };
}
