import { mergeRouters, router } from "./procedures.ts";
import type { AnyTRPCRouter } from "@trpc/server";

function getRouterRecord(routerInstance: AnyTRPCRouter): Record<string, unknown> {
  const record = (routerInstance as { _def?: { record?: Record<string, unknown> } })
    ._def?.record;
  return record ?? {};
}

export function createAppRouter(
  crudRouters: Record<string, AnyTRPCRouter>,
  extendRouter?: AnyTRPCRouter,
) {
  const baseRouter = router({ ...crudRouters });
  if (!extendRouter) {
    return baseRouter;
  }

  const baseKeys = new Set(Object.keys(getRouterRecord(baseRouter)));
  const extendKeys = Object.keys(getRouterRecord(extendRouter));
  const collisions = extendKeys.filter((key) => baseKeys.has(key));
  if (collisions.length > 0) {
    throw new Error(
      `TSBase: Cannot merge extend router due to key collision(s): ${collisions.join(", ")}`,
    );
  }

  return mergeRouters(baseRouter, extendRouter);
}

export type AppRouter = ReturnType<typeof createAppRouter>;
