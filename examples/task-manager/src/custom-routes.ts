/**
 * Example custom routes using ExtendContext auth extraction and raw DB access.
 */
import type { ExtendContext, RouteMap } from "bunbase";

export function customRoutes({ db, extractAuth }: ExtendContext): RouteMap {
  return {
    "/api/stats": {
      GET: async (_req) => {
        const sqlite = (db as any).$client;
        const result = sqlite
          .query("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
          .all() as { status: string; count: number }[];
        const counts: Record<string, number> = { todo: 0, in_progress: 0, done: 0 };
        for (const row of result) {
          counts[row.status] = row.count;
        }
        return Response.json({
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          ...counts,
        });
      },
    },

    "/api/my-tasks": {
      GET: async (req) => {
        const auth = await extractAuth(req);
        if (!auth) {
          return Response.json(
            { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
            { status: 401 },
          );
        }
        const sqlite = (db as any).$client;
        const tasks = sqlite
          .query(
            "SELECT id, title, description, status, priority, project_id FROM tasks WHERE assignee_id = ?1 ORDER BY created_at DESC",
          )
          .all(auth.id) as {
          id: string;
          title: string;
          description: string | null;
          status: string;
          priority: string;
          project_id: string;
        }[];
        return Response.json(tasks);
      },
    },
  };
}
