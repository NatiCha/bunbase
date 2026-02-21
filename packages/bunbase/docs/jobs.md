---
title: Jobs
---

Jobs run background tasks on a cron schedule — clean up expired records, send digest emails, sync external data, or anything else that needs to happen on a timer.

## Defining jobs

Use `defineJobs` to declare a list of scheduled tasks:

```ts
// src/jobs.ts
import { defineJobs } from "bunbase";
import { lt } from "drizzle-orm";
import { sessions } from "./schema";

export const jobs = defineJobs([
  {
    name: "cleanup-sessions",
    schedule: "0 * * * *",  // top of every hour
    run: async ({ db }) => {
      await db.delete(sessions).where(lt(sessions.expiresAt, Date.now()));
    },
  },

  {
    name: "daily-digest",
    schedule: "0 8 * * *",  // 8:00 AM every day
    run: async ({ db }) => {
      const users = await db.select().from(usersTable);
      for (const user of users) {
        await sendDigestEmail(user.email);
      }
    },
  },
]);
```

Pass jobs to `createServer`:

```ts
const bunbase = createServer({ schema, rules, hooks, jobs });
```

Jobs start automatically when `bunbase.listen()` is called, after the database has finished bootstrapping.

## Job definition

Each job has three fields:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique identifier. Duplicate names throw a startup error. |
| `schedule` | `string` | 5-field cron expression (see below) |
| `run` | `async (ctx) => void` | Function to execute |

## Job context

The `run` function receives a context object:

```ts
type JobContext = {
  db: AnyDb; // Drizzle database instance
};
```

Use `db` to read and write to your database, exactly as you would in a custom route or hook:

```ts
{
  name: "archive-old-posts",
  schedule: "0 2 * * *",  // 2:00 AM daily
  run: async ({ db }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    await db.update(posts).set({ archived: true }).where(lt(posts.createdAt, cutoff));
  },
},
```

## Cron expressions

Jobs use standard 5-field cron syntax: `minute hour day-of-month month day-of-week`.

```
┌─────── minute (0–59)
│ ┌───── hour (0–23)
│ │ ┌─── day of month (1–31)
│ │ │ ┌─ month (1–12)
│ │ │ │ ┌ day of week (0–6, Sunday=0)
│ │ │ │ │
* * * * *
```

### Supported syntax

| Syntax | Example | Meaning |
|---|---|---|
| `*` | `* * * * *` | Every minute |
| Fixed value | `0 9 * * *` | 9:00 AM every day |
| Step (`*/N`) | `*/15 * * * *` | Every 15 minutes |

### Common schedules

| Schedule | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Top of every hour |
| `0 0 * * *` | Midnight every day |
| `0 8 * * *` | 8:00 AM every day |
| `0 9 * * 1` | 9:00 AM every Monday |
| `0 0 1 * *` | Midnight on the 1st of each month |

### Day-of-week + day-of-month

When both `day-of-month` and `day-of-week` are specified (neither is `*`), standard cron OR semantics apply: the job runs if **either** condition matches.

```
0 0 1 * 0   →  midnight on the 1st of the month OR on any Sunday
```

## Scheduling behaviour

Jobs are **wall-clock aligned**, not interval-based. A job with `*/15 * * * *` fires at `:00`, `:15`, `:30`, `:45` — not 15 minutes after the previous run. If the server starts at `:07`, the first tick waits until `:15`.

Each job is rescheduled independently after it completes, so a slow run does not drift the clock for other jobs.

## Error handling

If a job throws, the error is caught and logged — the server keeps running and the job is rescheduled for its next tick:

```
[BunBase] Job "daily-digest" failed: Error: SMTP connection refused
```

## Overlap prevention

If a job is still executing when its next scheduled tick arrives, that tick is skipped and a warning is logged:

```
[BunBase] Job "cleanup-sessions" is still running from previous tick — skipping
```

The job resumes normal scheduling on the following tick.

## Constraints

- **Job names must be unique.** Duplicate names throw a startup error at `createServer()` time, before any async work.
- **Schedules must be valid 5-field cron expressions.** Invalid expressions are logged and that job is not scheduled.
- **Jobs run in the local system timezone.** There is no per-job timezone configuration in v1.

## Next steps

- [Hooks](/hooks/) — run code before or after individual CRUD operations
- [Extending](/extending/) — add custom REST routes
- [Configuration](/configuration/) — full `defineConfig` reference
