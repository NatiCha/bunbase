import { test, expect } from "bun:test";
import { router, publicProcedure, protectedProcedure } from "../trpc/procedures.ts";
import { createContextFactory } from "../trpc/context.ts";
import type { Context } from "../trpc/context.ts";

// ─── protectedProcedure ─────────────────────────────────────────────────────

test("protectedProcedure throws UNAUTHORIZED when auth is null", async () => {
  const testRouter = router({
    secret: protectedProcedure.query(() => "secret-data"),
  });

  const caller = testRouter.createCaller({
    db: {} as never,
    auth: null,
    req: new Request("http://localhost"),
  } as Context);

  let code = "";
  try {
    await caller.secret();
  } catch (err) {
    code = (err as { code?: string }).code ?? "";
  }
  expect(code).toBe("UNAUTHORIZED");
});

test("protectedProcedure allows access and exposes auth when user is authenticated", async () => {
  const testRouter = router({
    whoami: protectedProcedure.query(({ ctx }) => ctx.auth.id),
  });

  const caller = testRouter.createCaller({
    db: {} as never,
    auth: { id: "user-42", email: "test@example.com", role: "user" },
    req: new Request("http://localhost"),
  } as Context);

  const result = await caller.whoami();
  expect(result).toBe("user-42");
});

test("protectedProcedure preserves the full context for downstream handlers", async () => {
  const testRouter = router({
    ctx: protectedProcedure.query(({ ctx }) => ({
      id: ctx.auth.id,
      role: ctx.auth.role,
    })),
  });

  const caller = testRouter.createCaller({
    db: {} as never,
    auth: { id: "admin-1", email: "admin@example.com", role: "admin" },
    req: new Request("http://localhost"),
  } as Context);

  const result = await caller.ctx();
  expect(result.id).toBe("admin-1");
  expect(result.role).toBe("admin");
});

// ─── createContextFactory ───────────────────────────────────────────────────

test("createContextFactory creates context with extracted auth user", async () => {
  const mockUser = { id: "u1", email: "u@example.com", role: "user" };

  const factory = createContextFactory({
    db: {} as never,
    extractAuth: async () => mockUser,
  });

  const req = new Request("http://localhost/api/test");
  const ctx = await factory({ req });

  expect(ctx.auth).toEqual(mockUser);
  expect(ctx.req).toBe(req);
});

test("createContextFactory creates context with null auth when not authenticated", async () => {
  const factory = createContextFactory({
    db: {} as never,
    extractAuth: async () => null,
  });

  const ctx = await factory({ req: new Request("http://localhost") });
  expect(ctx.auth).toBeNull();
});

test("createContextFactory passes the db reference through", async () => {
  const mockDb = { query: () => {} } as never;

  const factory = createContextFactory({
    db: mockDb,
    extractAuth: async () => null,
  });

  const ctx = await factory({ req: new Request("http://localhost") });
  expect(ctx.db).toBe(mockDb);
});

// ─── publicProcedure (sanity check) ─────────────────────────────────────────

test("publicProcedure works without auth", async () => {
  const testRouter = router({
    ping: publicProcedure.query(() => "pong"),
  });

  const caller = testRouter.createCaller({
    db: {} as never,
    auth: null,
    req: new Request("http://localhost"),
  } as Context);

  expect(await caller.ping()).toBe("pong");
});
