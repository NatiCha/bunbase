export type TemplateType =
  | "task-manager"
  | "blog"
  | "saas"
  | "inventory"
  | "empty";
export type OAuthProvider = "google" | "github" | "discord";
export type DatabaseDriver = "sqlite" | "postgres" | "mysql";

export interface Template {
  schema: string;
  rules: string;
  indexTs: string;
  drizzleConfig: string;
  env: string;
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
  return `import { createServer, defineConfig } from "bunbase";
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
  const lines = [
    "# BunBase Configuration",
    "# NODE_ENV=production",
    "# PORT=3000",
  ];
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
  return lines.join("\n") + "\n";
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

const taskManagerRules = `import { defineRules, authenticated, ownerOnly } from "bunbase";
import { projects } from "./schema";

export const rules = defineRules({
  projects: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(projects.ownerId as any, auth),
    delete: ({ auth }) => ownerOnly(projects.ownerId as any, auth),
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

const blogRules = `import { defineRules, authenticated, ownerOnly } from "bunbase";
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
    update: ({ auth }) => ownerOnly(posts.authorId as any, auth),
    delete: ({ auth }) => ownerOnly(posts.authorId as any, auth),
  },
  comments: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => ownerOnly(comments.authorId as any, auth),
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

const saasRules = `import { defineRules, authenticated } from "bunbase";

export const rules = defineRules({
  organizations: {
    list: ({ auth }) => authenticated(auth),
    get: ({ auth }) => authenticated(auth),
    create: ({ auth }) => authenticated(auth),
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  members: {
    list: ({ auth }) => authenticated(auth),
    get: ({ auth }) => authenticated(auth),
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  invoices: {
    list: ({ auth }) => authenticated(auth),
    get: ({ auth }) => authenticated(auth),
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

const inventoryRules = `import { defineRules, authenticated } from "bunbase";

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

const emptyRules = `import { defineRules } from "bunbase";

export const rules = defineRules({});
`;

// ─── Template registry ────────────────────────────────────────────────────────

type TemplateBody = {
  schema: (driver: DatabaseDriver) => string;
  rules: string;
  tables: string[];
  description: string;
};

const TEMPLATES: Record<TemplateType, TemplateBody> = {
  "task-manager": {
    schema: taskManagerSchema,
    rules: taskManagerRules,
    tables: ["projects", "tasks"],
    description: "Project & task tracking",
  },
  blog: {
    schema: blogSchema,
    rules: blogRules,
    tables: ["categories", "posts", "comments"],
    description: "Blog with categories & comments",
  },
  saas: {
    schema: saasSchema,
    rules: saasRules,
    tables: ["organizations", "members", "invoices"],
    description: "Multi-tenant SaaS",
  },
  inventory: {
    schema: inventorySchema,
    rules: inventoryRules,
    tables: ["categories", "products", "orders", "orderItems"],
    description: "E-commerce / inventory",
  },
  empty: {
    schema: emptySchema,
    rules: emptyRules,
    tables: [],
    description: "Blank slate (users only)",
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
    tables: t.tables,
    description: t.description,
  };
}

export function slugifyDbName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "myapp";
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
