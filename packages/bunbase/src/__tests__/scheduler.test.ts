/**
 * Unit tests for the cron scheduler: nextCronTime() and JobScheduler.
 */
import { describe, expect, test } from "bun:test";
import { JobScheduler, nextCronTime } from "../jobs/scheduler.ts";

type TimerFn = () => void;

// ── nextCronTime ──────────────────────────────────────────────────────────────

describe("nextCronTime", () => {
  test("throws on wrong field count", () => {
    expect(() => nextCronTime("* * * *")).toThrow("5 fields");
    expect(() => nextCronTime("* * * * * *")).toThrow("5 fields");
  });

  test("throws on non-numeric fixed values", () => {
    expect(() => nextCronTime("abc * * * *")).toThrow();
    expect(() => nextCronTime("* * 0 * *")).toThrow(); // day-of-month 0 is out of range
  });

  test("* * * * * — every minute — next minute after given time", () => {
    const after = new Date("2025-01-01T00:00:00.000Z");
    const next = nextCronTime("* * * * *", after);
    // Should be exactly 1 minute later
    expect(next.getTime()).toBe(after.getTime() + 60_000);
  });

  test("*/5 * * * * — every 5 minutes — next 5-minute boundary", () => {
    // After :03, next should be :05
    const after = new Date("2025-01-01T00:03:00.000Z");
    const next = nextCronTime("*/5 * * * *", after);
    expect(next.getMinutes()).toBe(5);
    expect(next.getHours()).toBe(after.getHours());
  });

  test("0 * * * * — top of every hour — next :00 after given time", () => {
    const after = new Date("2025-01-01T10:30:00.000Z");
    const next = nextCronTime("0 * * * *", after);
    expect(next.getMinutes()).toBe(0);
    // Should be 11:00
    expect(next.getHours() > after.getHours() || next.getDate() > after.getDate()).toBe(true);
  });

  test("0 0 * * * — midnight daily — next midnight", () => {
    const after = new Date("2025-01-01T10:30:00.000Z");
    const next = nextCronTime("0 0 * * *", after);
    expect(next.getMinutes()).toBe(0);
    expect(next.getHours()).toBe(0);
    expect(next.getDate()).toBe(2); // Next day's midnight (in local time)
  });

  test("30 14 * * * — specific time — resolves to correct HH:MM", () => {
    // Use local time: set after to same day before 14:30
    const after = new Date();
    after.setHours(10, 0, 0, 0);
    const next = nextCronTime("30 14 * * *", after);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
  });

  test("0 0 1 * * — first of each month — lands on day 1", () => {
    const after = new Date();
    after.setDate(15);
    after.setHours(0, 0, 0, 0);
    const next = nextCronTime("0 0 1 * *", after);
    expect(next.getDate()).toBe(1);
    expect(next.getMonth()).toBeGreaterThan(after.getMonth() - 1); // next month
  });

  test("OR semantics: dom=1, dow=0 — matches day 1 OR Sunday", () => {
    // After a Tuesday, 2025-01-07 — next should be either day 1 of a month or next Sunday
    const after = new Date("2025-01-07T12:00:00.000Z"); // Tuesday
    const next = nextCronTime("0 0 1 * 0", after); // midnight, day 1 OR Sunday
    // The result must be a day-of-month 1 OR a Sunday
    const isFirst = next.getDate() === 1;
    const isSunday = next.getDay() === 0;
    expect(isFirst || isSunday).toBe(true);
  });

  test("fixed dow: */1 * * * 1 — every Monday at any minute", () => {
    // Start from a Sunday
    const after = new Date("2025-01-05T23:59:00.000Z"); // Sunday
    const next = nextCronTime("* * * * 1", after); // any minute on Monday
    expect(next.getDay()).toBe(1); // Monday
  });

  test("step syntax: */15 * * * * — every 15 minutes", () => {
    const after = new Date();
    after.setMinutes(7, 0, 0);
    const next = nextCronTime("*/15 * * * *", after);
    expect(next.getMinutes() % 15).toBe(0);
  });
});

// ── JobScheduler ──────────────────────────────────────────────────────────────

describe("JobScheduler", () => {
  const fakeDb = {} as any;

  test("start() schedules via setTimeout at computed next time", async () => {
    let _ranCount = 0;
    const scheduler = new JobScheduler(fakeDb);

    // Use a cron that would fire in the near future — we'll fast-forward
    // Instead, use mock timers approach: record setTimeout calls
    const originalSetTimeout = globalThis.setTimeout;
    const timeouts: Array<{ fn: TimerFn; delay: number }> = [];
    globalThis.setTimeout = ((fn: TimerFn, delay: number) => {
      timeouts.push({ fn, delay });
      return 999 as any;
    }) as any;

    scheduler.start([
      {
        name: "test-job",
        schedule: "* * * * *",
        run: async () => {
          _ranCount++;
        },
      },
    ]);

    // Should have scheduled exactly one timeout
    expect(timeouts.length).toBe(1);
    // Delay should be positive (within next minute)
    expect(timeouts[0].delay).toBeGreaterThan(0);
    expect(timeouts[0].delay).toBeLessThanOrEqual(60_000);

    globalThis.setTimeout = originalSetTimeout;
    scheduler.stop();
  });

  test("stop() clears all pending timeouts", () => {
    const scheduler = new JobScheduler(fakeDb);
    let cleared = false;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = (_id: any) => {
      cleared = true;
    };

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((_fn: TimerFn, _delay: number) => 42 as any) as any;

    scheduler.start([
      {
        name: "stopper",
        schedule: "* * * * *",
        run: async () => {},
      },
    ]);
    scheduler.stop();
    expect(cleared).toBe(true);

    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  test("started guard: calling start() twice logs warning and ignores second call", () => {
    const scheduler = new JobScheduler(fakeDb);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((_fn: TimerFn, _delay: number) => 1 as any) as any;

    scheduler.start([{ name: "j1", schedule: "* * * * *", run: async () => {} }]);
    scheduler.start([{ name: "j2", schedule: "* * * * *", run: async () => {} }]);

    expect(warnings.some((w) => w.includes("more than once"))).toBe(true);

    console.warn = origWarn;
    globalThis.setTimeout = originalSetTimeout;
    scheduler.stop();
  });

  test("job errors are caught and logged — no crash", async () => {
    const scheduler = new JobScheduler(fakeDb);
    const errors: any[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => errors.push(args);

    const originalSetTimeout = globalThis.setTimeout;
    let capturedFn: TimerFn | null = null;
    // First call captures the scheduler fn; subsequent calls are no-ops
    let callCount = 0;
    globalThis.setTimeout = ((fn: TimerFn, _delay: number) => {
      callCount++;
      if (callCount === 1) capturedFn = fn;
      return callCount as any;
    }) as any;

    scheduler.start([
      {
        name: "failing-job",
        schedule: "* * * * *",
        run: async () => {
          throw new Error("Boom!");
        },
      },
    ]);

    // Simulate the timer firing
    if (capturedFn) {
      await capturedFn();
    }

    expect(errors.some((e) => e.some((s: any) => String(s).includes("failing-job")))).toBe(true);

    console.error = origError;
    globalThis.setTimeout = originalSetTimeout;
    scheduler.stop();
  });

  test("overlap prevention: long-running job skips next tick and logs warning", async () => {
    const scheduler = new JobScheduler(fakeDb);
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));

    const originalSetTimeout = globalThis.setTimeout;
    const capturedFns: TimerFn[] = [];
    globalThis.setTimeout = ((fn: TimerFn, _delay: number) => {
      capturedFns.push(fn);
      return capturedFns.length as any;
    }) as any;

    // Simulate a job that blocks until we resolve it
    let resolveJob!: () => void;
    const jobBlocker = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    scheduler.start([
      {
        name: "slow-job",
        schedule: "* * * * *",
        run: async () => {
          await jobBlocker;
        },
      },
    ]);

    // First tick: job starts running (sets running=true, awaits jobBlocker)
    const firstTickFn = capturedFns[0];
    const firstRun = firstTickFn(); // don't await — job is blocked

    // Give the async machinery a tick so running=true is set
    await new Promise<void>((r) => {
      globalThis.setTimeout = originalSetTimeout;
      setTimeout(r, 10);
    });

    // Restore the mock for the next scheduleNext call
    globalThis.setTimeout = ((fn: TimerFn, _delay: number) => {
      capturedFns.push(fn);
      return capturedFns.length as any;
    }) as any;

    // Simulate the same timer firing again while job is still running —
    // calling firstTickFn again mimics the scheduler receiving a second tick
    await firstTickFn();

    expect(warnings.some((w) => w.includes("slow-job") && w.includes("skipping"))).toBe(true);

    // Unblock the first run and clean up
    resolveJob();
    await firstRun;

    console.warn = origWarn;
    globalThis.setTimeout = originalSetTimeout;
    scheduler.stop();
  });

  test("stopped flag: in-flight job does not reschedule after stop()", async () => {
    const scheduler = new JobScheduler(fakeDb);

    const originalSetTimeout = globalThis.setTimeout;
    const capturedFns: TimerFn[] = [];
    globalThis.setTimeout = ((fn: TimerFn, _delay: number) => {
      capturedFns.push(fn);
      return capturedFns.length as any;
    }) as any;

    let resolveJob!: () => void;
    const jobBlocker = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    scheduler.start([
      {
        name: "in-flight-job",
        schedule: "* * * * *",
        run: async () => {
          await jobBlocker;
        },
      },
    ]);

    const firstTickFn = capturedFns[0];
    const firstRun = firstTickFn(); // don't await — job is blocked

    // Restore real setTimeout before stop()
    globalThis.setTimeout = originalSetTimeout;

    // Give the async machinery a microtask so running=true is set
    await new Promise<void>((r) => setTimeout(r, 10));

    // Call stop() while the job is still in-flight
    scheduler.stop();

    // Resolve the blocker — runJob should NOT call scheduleNext because stopped=true
    const timeoutsBefore = capturedFns.length;
    resolveJob();
    await firstRun;

    // No new timer should have been registered after the job finished
    expect(capturedFns.length).toBe(timeoutsBefore);
  });

  test("duplicate job names: start() throws before scheduling any timers", () => {
    const scheduler = new JobScheduler(fakeDb);
    const originalSetTimeout = globalThis.setTimeout;
    const timerCount = { n: 0 };
    globalThis.setTimeout = ((_fn: TimerFn, _delay: number) => {
      timerCount.n++;
      return timerCount.n as any;
    }) as any;

    expect(() =>
      scheduler.start([
        { name: "dup", schedule: "* * * * *", run: async () => {} },
        { name: "dup", schedule: "0 * * * *", run: async () => {} },
      ]),
    ).toThrow('Duplicate job name: "dup"');

    // No timers should have been set (throw happens before scheduling)
    expect(timerCount.n).toBe(0);

    globalThis.setTimeout = originalSetTimeout;
  });

  test("started flag is not stuck after duplicate-name throw — scheduler can still be started", () => {
    const scheduler = new JobScheduler(fakeDb);
    const originalSetTimeout = globalThis.setTimeout;
    const timerCount = { n: 0 };
    globalThis.setTimeout = ((_fn: TimerFn, _delay: number) => {
      timerCount.n++;
      return timerCount.n as any;
    }) as any;

    // First start attempt fails with duplicate names
    expect(() =>
      scheduler.start([
        { name: "dup", schedule: "* * * * *", run: async () => {} },
        { name: "dup", schedule: "0 * * * *", run: async () => {} },
      ]),
    ).toThrow();

    // Second start attempt with valid names should succeed
    expect(() =>
      scheduler.start([{ name: "ok", schedule: "* * * * *", run: async () => {} }]),
    ).not.toThrow();

    expect(timerCount.n).toBe(1); // one timer registered for the valid job

    globalThis.setTimeout = originalSetTimeout;
    scheduler.stop();
  });

  test("scheduler can be restarted after stop()", () => {
    const scheduler = new JobScheduler(fakeDb);
    const originalSetTimeout = globalThis.setTimeout;
    const timerCount = { n: 0 };
    globalThis.setTimeout = ((_fn: TimerFn, _delay: number) => {
      timerCount.n++;
      return timerCount.n as any;
    }) as any;

    scheduler.start([{ name: "restartable", schedule: "* * * * *", run: async () => {} }]);
    expect(timerCount.n).toBe(1);

    scheduler.stop();

    // After stop(), started=false and stopped=true — start() should reset stopped and work
    scheduler.start([{ name: "restartable", schedule: "* * * * *", run: async () => {} }]);
    expect(timerCount.n).toBe(2); // new timer registered

    globalThis.setTimeout = originalSetTimeout;
    scheduler.stop();
  });
});
