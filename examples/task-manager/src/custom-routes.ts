import { router, publicProcedure, protectedProcedure } from "tsbase";

export const customRouter = router({
  stats: publicProcedure.query(({ ctx }) => {
    const sqlite = (ctx.db as any).$client;
    const result = sqlite
      .query("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
      .all() as { status: string; count: number }[];
    const counts: Record<string, number> = { todo: 0, in_progress: 0, done: 0 };
    for (const row of result) {
      counts[row.status] = row.count;
    }
    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      ...counts,
    };
  }),

  myTasks: protectedProcedure.query(({ ctx }) => {
    const sqlite = (ctx.db as any).$client;
    return sqlite
      .query(
        "SELECT id, title, description, status, priority, project_id FROM tasks WHERE assignee_id = ?1 ORDER BY created_at DESC",
      )
      .all(ctx.auth.id) as {
      id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      project_id: string;
    }[];
  }),
});
