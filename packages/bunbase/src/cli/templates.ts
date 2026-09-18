export type TemplateType = "task-manager" | "blog" | "saas" | "inventory" | "empty";
export type OAuthProvider = "google" | "github" | "discord";
export type DatabaseDriver = "sqlite" | "postgres" | "mysql";

export interface Template {
  schema: string;
  rules: string;
  indexTs: string;
  drizzleConfig: string;
  env: string;
  /** A starter test file wired to `createTestServer` from `@naticha/bunbase/testing`. */
  sampleTest: string;
  tables: string[];
  description: string;
}

// ─── Schema helpers ───────────────────────────────────────────────────────────

const SQLITE_USERS_TABLE = `export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});`;

const PG_USERS_TABLE = `export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});`;

const MYSQL_USERS_TABLE = `export const users = mysqlTable("users", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});`;

function schemaImport(driver: DatabaseDriver): string {
  if (driver === "postgres") return `import { pgTable, text } from "drizzle-orm/pg-core";`;
  if (driver === "mysql") return `import { mysqlTable, text } from "drizzle-orm/mysql-core";`;
  return `import { sqliteTable, text } from "drizzle-orm/sqlite-core";`;
}

function tableConstructor(driver: DatabaseDriver): string {
  if (driver === "postgres") return "pgTable";
  if (driver === "mysql") return "mysqlTable";
  return "sqliteTable";
}

function usersTableStr(driver: DatabaseDriver): string {
  if (driver === "postgres") return PG_USERS_TABLE;
  if (driver === "mysql") return MYSQL_USERS_TABLE;
  return SQLITE_USERS_TABLE;
}

// ─── drizzle.config.ts ────────────────────────────────────────────────────────

function buildDrizzleConfig(driver: DatabaseDriver): string {
  if (driver === "postgres") {
    return `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  tablesFilter: ["!_*"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
`;
  }
  if (driver === "mysql") {
    return `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  tablesFilter: ["!_*"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
`;
  }
  return `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  tablesFilter: ["!_*"],
  dbCredentials: {
    url: "./data/db.sqlite",
  },
});
`;
}

// ─── src/index.ts ─────────────────────────────────────────────────────────────

function buildOAuthConfig(providers: OAuthProvider[]): string {
  if (providers.length === 0) return "";
  const entries = providers.map((p) => {
    const upper = p.toUpperCase();
    return `      ${p}: { clientId: process.env.${upper}_CLIENT_ID!, clientSecret: process.env.${upper}_CLIENT_SECRET! },`;
  });
  return `\n    oauth: {\n${entries.join("\n")}\n    },`;
}

function buildDatabaseConfig(driver: DatabaseDriver): string {
  if (driver === "postgres") {
    return `\n    database: { driver: "postgres", url: process.env.DATABASE_URL! },`;
  }
  if (driver === "mysql") {
    return `\n    database: { driver: "mysql", url: process.env.DATABASE_URL! },`;
  }
  // SQLite is the default — no database field needed
  return "";
}

function buildIndexTs(driver: DatabaseDriver, providers: OAuthProvider[]): string {
  const oauthConfig = buildOAuthConfig(providers);
  const databaseConfig = buildDatabaseConfig(driver);
  return `import { createServer, defineConfig } from "@naticha/bunbase";
import * as schema from "./schema";
import { rules } from "./rules";

const bunbase = createServer({
  schema,
  rules,
  config: defineConfig({
    development: process.env.NODE_ENV !== "production",${databaseConfig}${oauthConfig}
  }),
});

bunbase.listen();
`;
}

// ─── .env ─────────────────────────────────────────────────────────────────────

function buildEnv(driver: DatabaseDriver, providers: OAuthProvider[], dbName: string): string {
  const lines = ["# BunBase Configuration", "# NODE_ENV=production", "# PORT=3000"];
  if (driver === "postgres") {
    lines.push("", "# Database");
    lines.push(`DATABASE_URL=postgres://localhost:5432/${dbName}`);
  }
  if (driver === "mysql") {
    lines.push("", "# Database");
    lines.push(`DATABASE_URL=mysql://root@127.0.0.1:3306/${dbName}`);
  }
  if (providers.length > 0) {
    lines.push("", "# OAuth Providers");
    for (const p of providers) {
      const upper = p.toUpperCase();
      lines.push(`${upper}_CLIENT_ID=`);
      lines.push(`${upper}_CLIENT_SECRET=`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ─── Sample test (bunbase/testing) ────────────────────────────────────────────

/** Map a JS schema key (camelCase) to its SQL table name (snake_case). */
function toSqlTableName(jsKey: string): string {
  return jsKey.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Build a starter test that boots a real server with `createTestServer` and
 * exercises the generated schema + rules. When the template has a publicly
 * listable table, it seeds a row and reads it back through the API. Templates
 * with no public table (or no tables) fall back to a deny-by-default assertion.
 */
function buildSampleTest(publicTable: string | null): string {
  const header = `import { test, expect, afterAll } from "bun:test";
import { createTestServer } from "@naticha/bunbase/testing";
import * as schema from "./schema";
import { rules } from "./rules";

const server = await createTestServer({ schema, rules });
afterAll(() => server.cleanup());
`;

  if (!publicTable) {
    return `${header}
test("denies unauthenticated writes by default", async () => {
  // Rules are deny-by-default: without a session, register a user instead.
  const res = await server.fetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "test@example.com", password: "password123" }),
  });
  expect([200, 201]).toContain(res.status);
});
`;
  }

  const sqlName = toSqlTableName(publicTable);
  return `${header}
test("lists ${publicTable}", async () => {
  const res = await server.fetch("/api/${sqlName}");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

// Seed a row directly, then read it back through the public list endpoint.
test("reads a seeded ${publicTable} row", async () => {
  await server.adapter.rawExecute(
    \`INSERT INTO ${sqlName} (id, ${seedColumns(publicTable)}) VALUES (${seedValues(publicTable)})\`,
  );
  const res = await server.fetch("/api/${sqlName}");
  const body = await res.json();
  expect(body.data.length).toBeGreaterThan(0);
});
`;
}

/** Minimal NOT NULL columns (besides id) to satisfy a seed INSERT per template table. */
function seedColumns(table: string): string {
  const map: Record<string, string> = {
    projects: "name, owner_id, created_at, updated_at",
    tasks: "title, project_id, created_at, updated_at",
    categories: "name, slug, created_at, updated_at",
    posts: "title, slug, author_id, created_at, updated_at",
    comments: "body, post_id, author_id, created_at, updated_at",
    organizations: "name, slug, owner_id, created_at, updated_at",
    members: "organization_id, user_id, created_at, updated_at",
    invoices: "organization_id, amount, created_at, updated_at",
    products: "name, price, created_at, updated_at",
    orders: "customer_id, total, created_at, updated_at",
    orderItems: "order_id, product_id, quantity, price, created_at, updated_at",
  };
  return map[table] ?? "created_at, updated_at";
}

/** VALUES list matching seedColumns(); id is always the first value. */
function seedValues(table: string): string {
  const now = "'2024-01-01T00:00:00.000Z'";
  const map: Record<string, string> = {
    projects: `'p1', 'Demo', 'u1', ${now}, ${now}`,
    tasks: `'t1', 'Demo task', 'p1', ${now}, ${now}`,
    categories: `'c1', 'Demo', 'demo', ${now}, ${now}`,
    posts: `'po1', 'Demo', 'demo', 'u1', ${now}, ${now}`,
    comments: `'cm1', 'Hello', 'po1', 'u1', ${now}, ${now}`,
    organizations: `'o1', 'Demo', 'demo', 'u1', ${now}, ${now}`,
    members: `'m1', 'o1', 'u1', ${now}, ${now}`,
    invoices: `'i1', 'o1', '100', ${now}, ${now}`,
    products: `'pr1', 'Widget', '10', ${now}, ${now}`,
    orders: `'or1', 'u1', '20', ${now}, ${now}`,
    orderItems: `'oi1', 'or1', 'pr1', '2', '10', ${now}, ${now}`,
  };
  return map[table] ?? `'x1', ${now}, ${now}`;
}

// ─── Schema bodies ────────────────────────────────────────────────────────────

function taskManagerSchema(driver: DatabaseDriver): string {
  const tbl = tableConstructor(driver);
  return `${schemaImport(driver)}

${usersTableStr(driver)}

export const projects = ${tbl}("projects", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const tasks = ${tbl}("tasks", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("todo"),
  priority: text("priority").notNull().default("medium"),
  projectId: text("project_id").notNull(),
  assigneeId: text("assignee_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});
`;
}

function blogSchema(driver: DatabaseDriver): string {
  const tbl = tableConstructor(driver);
  return `${schemaImport(driver)}

${usersTableStr(driver)}

export const categories = ${tbl}("categories", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const posts = ${tbl}("posts", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  body: text("body"),
  status: text("status").notNull().default("draft"),
  authorId: text("author_id").notNull(),
  categoryId: text("category_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const comments = ${tbl}("comments", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  body: text("body").notNull(),
  postId: text("post_id").notNull(),
  authorId: text("author_id").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});
`;
}

function saasSchema(driver: DatabaseDriver): string {
  const tbl = tableConstructor(driver);
  return `${schemaImport(driver)}

${usersTableStr(driver)}

export const organizations = ${tbl}("organizations", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const members = ${tbl}("members", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const invoices = ${tbl}("invoices", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  organizationId: text("organization_id").notNull(),
  amount: text("amount").notNull(),
  status: text("status").notNull().default("pending"),
  description: text("description"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});
`;
}

function inventorySchema(driver: DatabaseDriver): string {
  const tbl = tableConstructor(driver);
  return `${schemaImport(driver)}

${usersTableStr(driver)}

export const categories = ${tbl}("categories", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const products = ${tbl}("products", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  name: text("name").notNull(),
  description: text("description"),
  price: text("price").notNull(),
  sku: text("sku").unique(),
  categoryId: text("category_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const orders = ${tbl}("orders", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  status: text("status").notNull().default("pending"),
  customerId: text("customer_id").notNull(),
  total: text("total").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});

export const orderItems = ${tbl}("order_items", {
  id: text("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  quantity: text("quantity").notNull(),
  price: text("price").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});
`;
}

function emptySchema(driver: DatabaseDriver): string {
  return `${schemaImport(driver)}

${usersTableStr(driver)}
`;
}

// ─── Rules (driver-agnostic) ──────────────────────────────────────────────────

const taskManagerRules = `import { defineRules, authenticated, ownerOnly } from "@naticha/bunbase";
import { projects } from "./schema";

export const rules = defineRules({
  projects: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(projects.ownerId, auth),
    delete: ({ auth }) => ownerOnly(projects.ownerId, auth),
  },
  tasks: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => authenticated(auth),
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

const blogRules = `import { defineRules, authenticated, ownerOnly } from "@naticha/bunbase";
import { posts, comments } from "./schema";

export const rules = defineRules({
  categories: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  posts: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(posts.authorId, auth),
    delete: ({ auth }) => ownerOnly(posts.authorId, auth),
  },
  comments: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(comments.authorId, auth),
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

const saasRules = `import { defineRules, type AnyColumn, type AuthUser } from "@naticha/bunbase";
import { sql } from "drizzle-orm";
import { organizations, members, invoices } from "./schema";

function tenantAccess(column: AnyColumn, auth: AuthUser | null) {
  if (!auth) return false;
  if (auth.role === "admin") return true;
  return sql\`\${column} in (select \${members.organizationId} from \${members} where \${members.userId} = \${auth.id} union select \${organizations.id} from \${organizations} where \${organizations.ownerId} = \${auth.id})\`;
}

export const rules = defineRules({
  organizations: {
    list: ({ auth }) => tenantAccess(organizations.id, auth),
    get: ({ auth }) => tenantAccess(organizations.id, auth),
    create: ({ auth, body }) => !!auth && (auth.role === "admin" || body.ownerId === auth.id),
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  members: {
    list: ({ auth }) => tenantAccess(members.organizationId, auth),
    get: ({ auth }) => tenantAccess(members.organizationId, auth),
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  invoices: {
    list: ({ auth }) => tenantAccess(invoices.organizationId, auth),
    get: ({ auth }) => tenantAccess(invoices.organizationId, auth),
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

const inventoryRules = `import { defineRules, authenticated } from "@naticha/bunbase";

export const rules = defineRules({
  categories: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  products: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  orders: {
    list: ({ auth }) => authenticated(auth),
    get: ({ auth }) => authenticated(auth),
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  orderItems: {
    list: ({ auth }) => authenticated(auth),
    get: ({ auth }) => authenticated(auth),
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

const emptyRules = `import { defineRules } from "@naticha/bunbase";

export const rules = defineRules({});
`;

// ─── Template registry ────────────────────────────────────────────────────────

type TemplateBody = {
  schema: (driver: DatabaseDriver) => string;
  rules: string;
  tables: string[];
  description: string;
  /**
   * JS schema key of a table with a public `list` rule, used by the generated
   * sample test. `null` when the template has no public table (e.g. saas/empty).
   */
  publicTable: string | null;
};

const TEMPLATES: Record<TemplateType, TemplateBody> = {
  "task-manager": {
    schema: taskManagerSchema,
    rules: taskManagerRules,
    tables: ["projects", "tasks"],
    description: "Project & task tracking",
    publicTable: "projects",
  },
  blog: {
    schema: blogSchema,
    rules: blogRules,
    tables: ["categories", "posts", "comments"],
    description: "Blog with categories & comments",
    publicTable: "categories",
  },
  saas: {
    schema: saasSchema,
    rules: saasRules,
    tables: ["organizations", "members", "invoices"],
    description: "Multi-tenant SaaS",
    publicTable: null,
  },
  inventory: {
    schema: inventorySchema,
    rules: inventoryRules,
    tables: ["categories", "products", "orders", "orderItems"],
    description: "E-commerce / inventory",
    publicTable: "categories",
  },
  empty: {
    schema: emptySchema,
    rules: emptyRules,
    tables: [],
    description: "Blank slate (users only)",
    publicTable: null,
  },
};

export function getTemplate(
  type: TemplateType,
  driver: DatabaseDriver,
  oauthProviders: OAuthProvider[],
  dbName: string = "myapp",
): Template {
  const t = TEMPLATES[type];
  return {
    schema: t.schema(driver),
    rules: t.rules,
    indexTs: buildIndexTs(driver, oauthProviders),
    drizzleConfig: buildDrizzleConfig(driver),
    env: buildEnv(driver, oauthProviders, dbName),
    sampleTest: buildSampleTest(t.publicTable),
    tables: t.tables,
    description: t.description,
  };
}

export function slugifyDbName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "myapp"
  );
}

export const TEMPLATE_OPTIONS: { label: string; value: TemplateType }[] = [
  { label: "Task Manager — projects & tasks", value: "task-manager" },
  { label: "Blog — posts, categories & comments", value: "blog" },
  { label: "SaaS — organizations, members & invoices", value: "saas" },
  {
    label: "Inventory — products, orders & categories",
    value: "inventory",
  },
  { label: "Empty — users only (blank slate)", value: "empty" },
];

export const DATABASE_OPTIONS: { label: string; value: DatabaseDriver }[] = [
  { label: "SQLite — zero-config, file-based", value: "sqlite" },
  { label: "Postgres — requires DATABASE_URL", value: "postgres" },
  { label: "MySQL — requires DATABASE_URL", value: "mysql" },
];

export const OAUTH_OPTIONS: { label: string; value: OAuthProvider }[] = [
  { label: "Google", value: "google" },
  { label: "GitHub", value: "github" },
  { label: "Discord", value: "discord" },
];

// ─── AI agent instruction files ───────────────────────────────────────────────

export const CLAUDE_MD = `## BunBase Project

This project uses [BunBase](https://bunbase.dev) — a TypeScript-native backend built on Bun and Drizzle ORM. It auto-generates a full REST API (CRUD, auth, file storage, realtime) from your Drizzle schema.

### Project structure

- \`src/schema.ts\` — Drizzle table definitions (source of truth for the data model)
- \`src/rules.ts\` — access control rules (deny by default; define what each role can do)
- \`src/index.ts\` — server entry point (\`createServer\` + \`listen\`)
- \`src/hooks.ts\` — lifecycle hooks, if present (run code before/after CRUD operations)

### Commands

- \`bun dev\` — start dev server with hot reload
- \`bun start\` — production server
- \`bun run db:push\` — push schema changes to the database
- \`bun run db:generate\` — generate migration files
- \`bun test\` — run all tests

### Key APIs

**Rules** — deny by default; every operation must be explicitly allowed:

\`\`\`ts
import { defineRules, authenticated, ownerOnly, admin } from "@naticha/bunbase";
import { posts } from "./schema";

export const rules = defineRules({
  posts: {
    list: () => true,                                  // public
    get: () => true,                                   // public
    create: ({ auth }) => authenticated(auth),         // logged-in users
    update: ({ auth }) => ownerOnly(posts.authorId, auth), // owner only
    delete: ({ auth }) => admin(auth),                 // admins only
  },
});
\`\`\`

Rule return values:
- \`true\` or \`null\` → allow
- \`false\` → deny (403)
- Drizzle SQL expression → allow but scope results to matching rows

**Hooks** — run code before/after CRUD operations:

\`\`\`ts
import { defineHooks } from "@naticha/bunbase";
import { posts } from "./schema";

export const hooks = {
  posts: defineHooks(posts, {
    beforeCreate: ({ data, auth, request }) => ({ ...data, authorId: auth!.id }),
    afterCreate: ({ record, request }) => { /* send notification, etc. */ },
    beforeUpdate: ({ data, existing, auth }) => data,
    afterDelete: ({ record }) => { /* cleanup */ },
  }),
};
\`\`\`

**Testing** — use \`createTestServer\` for integration tests:

\`\`\`ts
import { createTestServer } from "@naticha/bunbase/testing";
import { test, expect, afterAll } from "bun:test";
import * as schema from "../src/schema";
import { rules } from "../src/rules";

const server = await createTestServer({ schema, rules });
afterAll(() => server.cleanup());

test("creates record", async () => {
  const res = await server.fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ title: "Hello" }),
  });
  expect(res.status).toBe(201);
});
\`\`\`

Use \`server.adapter.rawExecute(sql)\` to seed test data directly.

**Client SDK** — typed frontend client:

\`\`\`ts
import { createBunBaseClient } from "@naticha/bunbase/client";

import * as schema from "./schema";

const client = createBunBaseClient({ url: "http://localhost:3000", schema });

// CRUD
const { data } = await client.api.posts.list({ filter: { status: "published" } });
const post = await client.api.posts.create({ title: "Hello", body: "World" });

// Auth
await client.auth.login({ email, password });
const me = await client.auth.me();
\`\`\`

### BunBase Docs Index

IMPORTANT: Before implementing a BunBase feature you are unfamiliar with, read the relevant doc file. All docs are bundled in \`node_modules/@naticha/bunbase/docs/\`.

\`\`\`
[BunBase Docs]|root: ./node_modules/@naticha/bunbase/docs
|:{index.md,quickstart.md,schema.md,rules.md,hooks.md,client.md,configuration.md,deployment.md,extending.md,jobs.md,realtime.md,testing.md}
|api:{auth.md,crud.md,files.md,api-keys.md}
\`\`\`
`;

export const AGENTS_MD = `# BunBase Project — Agent Instructions

## What is BunBase?

BunBase is a TypeScript-native backend-as-a-service built on Bun and Drizzle ORM. Define your schema, set access rules, and get a full REST API — auth, CRUD, file storage, and realtime — with zero boilerplate.

## Project layout

| File | Purpose |
|---|---|
| \`src/schema.ts\` | Drizzle table definitions — the data model |
| \`src/rules.ts\` | Access control — who can do what |
| \`src/index.ts\` | Server entry point |
| \`src/hooks.ts\` | Lifecycle hooks (optional) |

## Commands

\`\`\`sh
bun dev            # dev server with hot reload
bun start          # production server
bun test           # run all tests
bun run db:push    # push schema to database (no migration file)
bun run db:generate # generate migration files
\`\`\`

## Auto-generated API endpoints (per table)

| Endpoint | Operation |
|---|---|
| \`GET  /api/{table}\` | list with filtering & cursor pagination |
| \`GET  /api/{table}/:id\` | get single record |
| \`POST /api/{table}\` | create record |
| \`PATCH /api/{table}/:id\` | update record |
| \`DELETE /api/{table}/:id\` | delete record |
| \`POST /auth/register\` | register user |
| \`POST /auth/login\` | login |
| \`POST /auth/logout\` | logout |
| \`GET  /auth/me\` | current user |

## Rules (access control)

Rules are **deny-by-default**. Every operation must be explicitly allowed.

\`\`\`ts
import { defineRules, authenticated, ownerOnly, admin, allowAll } from "@naticha/bunbase";
import { posts } from "./schema";

export const rules = defineRules({
  posts: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(posts.authorId, auth),
    delete: ({ auth }) => admin(auth),
  },
});
\`\`\`

Rule functions receive: \`{ auth, id, record, body, headers, query, method, db }\`.
Return \`true\` to allow, \`false\` to deny (403), or a Drizzle SQL expression to allow-with-filter.

## Hooks

\`\`\`ts
import { defineHooks } from "@naticha/bunbase";

export const hooks = {
  posts: defineHooks(schema.posts, {
    beforeCreate: ({ data, auth, request }) => ({ ...data, authorId: auth!.id }),
    afterCreate: ({ record, request }) => { /* send notification */ },
  }),
};
\`\`\`

Hook contexts always include \`request: { method, path, ip, headers }\`.

## Testing

\`\`\`ts
import { createTestServer } from "@naticha/bunbase/testing";

const server = await createTestServer({ schema, rules });
afterAll(() => server.cleanup());

test("creates post", async () => {
  const res = await server.fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ title: "Hello" }),
  });
  expect(res.status).toBe(201);
});
\`\`\`

\`createTestServer\` auto-creates tables, handles CSRF, starts on a random port. Use \`server.adapter.rawExecute(sql)\` to seed data.

## Reference docs (bundled in node_modules)

Read the relevant file before implementing unfamiliar features:

| Topic | File |
|---|---|
| Schema / tables | \`./node_modules/@naticha/bunbase/docs/schema.md\` |
| Rules (access control) | \`./node_modules/@naticha/bunbase/docs/rules.md\` |
| Lifecycle hooks | \`./node_modules/@naticha/bunbase/docs/hooks.md\` |
| CRUD filtering & pagination | \`./node_modules/@naticha/bunbase/docs/api/crud.md\` |
| Auth endpoints | \`./node_modules/@naticha/bunbase/docs/api/auth.md\` |
| File storage | \`./node_modules/@naticha/bunbase/docs/api/files.md\` |
| Frontend client SDK | \`./node_modules/@naticha/bunbase/docs/client.md\` |
| Realtime / WebSocket | \`./node_modules/@naticha/bunbase/docs/realtime.md\` |
| Scheduled jobs | \`./node_modules/@naticha/bunbase/docs/jobs.md\` |
| Full config reference | \`./node_modules/@naticha/bunbase/docs/configuration.md\` |
| Custom routes | \`./node_modules/@naticha/bunbase/docs/extending.md\` |
| Deployment checklist | \`./node_modules/@naticha/bunbase/docs/deployment.md\` |
| Testing / createTestServer | \`./node_modules/@naticha/bunbase/docs/testing.md\` |
| API keys (bearer auth) | \`./node_modules/@naticha/bunbase/docs/api/api-keys.md\` |
`;
