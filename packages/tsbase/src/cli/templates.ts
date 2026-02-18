export type TemplateType =
  | "task-manager"
  | "blog"
  | "saas"
  | "inventory"
  | "empty";
export type OAuthProvider = "google" | "github" | "discord";

export interface Template {
  schema: string;
  rules: string;
  indexTs: string;
  env: string;
  tables: string[];
  description: string;
}

const USERS_TABLE = `export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
});`;

function buildOAuthConfig(providers: OAuthProvider[]): string {
  if (providers.length === 0) return "";
  const entries = providers.map((p) => {
    const upper = p.toUpperCase();
    return `      ${p}: { clientId: process.env.${upper}_CLIENT_ID!, clientSecret: process.env.${upper}_CLIENT_SECRET! },`;
  });
  return `\n    oauth: {\n${entries.join("\n")}\n    },`;
}

function buildEnv(providers: OAuthProvider[]): string {
  const lines = [
    "# TSBase Configuration",
    "# NODE_ENV=production",
    "# PORT=3000",
  ];
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

function buildIndexTs(providers: OAuthProvider[]): string {
  const oauthConfig = buildOAuthConfig(providers);
  return `import { createServer, defineConfig } from "tsbase";
import * as schema from "./schema";
import { rules } from "./rules";

const tsbase = createServer({
  schema,
  rules,
  config: defineConfig({
    development: process.env.NODE_ENV !== "production",${oauthConfig}
  }),
});

tsbase.listen();
`;
}

// --- Task Manager ---

const taskManagerSchema = `import { sqliteTable, text } from "drizzle-orm/sqlite-core";

${USERS_TABLE}

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("todo"),
  priority: text("priority").notNull().default("medium"),
  projectId: text("project_id").notNull(),
  assigneeId: text("assignee_id"),
});
`;

const taskManagerRules = `import { defineRules, authenticated, ownerOnly } from "tsbase";
import { projects } from "./schema";

export const rules = defineRules({
  projects: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => ownerOnly(projects.ownerId as any, { auth }),
    delete: ({ auth }) => ownerOnly(projects.ownerId as any, { auth }),
  },
  tasks: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => authenticated({ auth }),
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

// --- Blog ---

const blogSchema = `import { sqliteTable, text } from "drizzle-orm/sqlite-core";

${USERS_TABLE}

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
});

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  body: text("body"),
  status: text("status").notNull().default("draft"),
  authorId: text("author_id").notNull(),
  categoryId: text("category_id"),
});

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  postId: text("post_id").notNull(),
  authorId: text("author_id").notNull(),
});
`;

const blogRules = `import { defineRules, authenticated, ownerOnly } from "tsbase";
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
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => ownerOnly(posts.authorId as any, { auth }),
    delete: ({ auth }) => ownerOnly(posts.authorId as any, { auth }),
  },
  comments: {
    list: () => true,
    get: () => true,
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => ownerOnly(comments.authorId as any, { auth }),
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

// --- SaaS ---

const saasSchema = `import { sqliteTable, text } from "drizzle-orm/sqlite-core";

${USERS_TABLE}

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: text("owner_id").notNull(),
});

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  amount: text("amount").notNull(),
  status: text("status").notNull().default("pending"),
  description: text("description"),
});
`;

const saasRules = `import { defineRules, authenticated } from "tsbase";

export const rules = defineRules({
  organizations: {
    list: ({ auth }) => authenticated({ auth }),
    get: ({ auth }) => authenticated({ auth }),
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  members: {
    list: ({ auth }) => authenticated({ auth }),
    get: ({ auth }) => authenticated({ auth }),
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  invoices: {
    list: ({ auth }) => authenticated({ auth }),
    get: ({ auth }) => authenticated({ auth }),
    create: ({ auth }) => auth?.role === "admin",
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

// --- Inventory ---

const inventorySchema = `import { sqliteTable, text } from "drizzle-orm/sqlite-core";

${USERS_TABLE}

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  price: text("price").notNull(),
  sku: text("sku").unique(),
  categoryId: text("category_id"),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  customerId: text("customer_id").notNull(),
  total: text("total").notNull(),
});

export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  quantity: text("quantity").notNull(),
  price: text("price").notNull(),
});
`;

const inventoryRules = `import { defineRules, authenticated } from "tsbase";

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
    list: ({ auth }) => authenticated({ auth }),
    get: ({ auth }) => authenticated({ auth }),
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
  orderItems: {
    list: ({ auth }) => authenticated({ auth }),
    get: ({ auth }) => authenticated({ auth }),
    create: ({ auth }) => authenticated({ auth }),
    update: ({ auth }) => auth?.role === "admin",
    delete: ({ auth }) => auth?.role === "admin",
  },
});
`;

// --- Empty ---

const emptySchema = `import { sqliteTable, text } from "drizzle-orm/sqlite-core";

${USERS_TABLE}
`;

const emptyRules = `import { defineRules } from "tsbase";

export const rules = defineRules({});
`;

// --- Template registry ---

const TEMPLATES: Record<
  TemplateType,
  { schema: string; rules: string; tables: string[]; description: string }
> = {
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
  oauthProviders: OAuthProvider[],
): Template {
  const t = TEMPLATES[type];
  return {
    schema: t.schema,
    rules: t.rules,
    indexTs: buildIndexTs(oauthProviders),
    env: buildEnv(oauthProviders),
    tables: t.tables,
    description: t.description,
  };
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

export const OAUTH_OPTIONS: { label: string; value: OAuthProvider }[] = [
  { label: "Google", value: "google" },
  { label: "GitHub", value: "github" },
  { label: "Discord", value: "discord" },
];
