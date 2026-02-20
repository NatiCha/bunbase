import type { AnyDb } from "../core/db-types.ts";
import type { JobDefinition } from "./types.ts";

type CronField = {
  value: number | "*" | { step: number };
};

function parseCronField(field: string, min: number, max: number): CronField["value"] {
  if (field === "*") return "*";
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${field}`);
    }
    return { step };
  }
  const n = parseInt(field, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid cron field value: ${field} (expected ${min}-${max})`);
  }
  return n;
}

function matchesCronField(value: CronField["value"], actual: number, min: number): boolean {
  if (value === "*") return true;
  if (typeof value === "number") return actual === value;
  // step: */N — matches when (actual - min) % step === 0
  return (actual - min) % value.step === 0;
}

/**
 * Computes the next wall-clock time that matches the given 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week
 */
export function nextCronTime(expression: string, after: Date = new Date()): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression (expected 5 fields): "${expression}"`);
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields;
  const minute = parseCronField(minuteField, 0, 59);
  const hour = parseCronField(hourField, 0, 23);
  const dom = parseCronField(domField, 1, 31);
  const month = parseCronField(monthField, 1, 12);
  const dow = parseCronField(dowField, 0, 6);

  // Standard cron OR semantics: if both dom and dow are restricted (not *), match either
  const domRestricted = domField !== "*";
  const dowRestricted = dowField !== "*";

  // Start searching from 1 minute after `after`
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 4 years to find a match
  const limit = new Date(after);
  limit.setFullYear(limit.getFullYear() + 4);

  while (candidate < limit) {
    // Check month (1-indexed)
    const m = candidate.getMonth() + 1;
    if (!matchesCronField(month, m, 1)) {
      // Skip to start of next month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day: OR semantics when both restricted
    const d = candidate.getDate();
    const w = candidate.getDay();
    const domMatch = matchesCronField(dom, d, 1);
    const dowMatch = matchesCronField(dow, w, 0);
    const dayMatch = (domRestricted && dowRestricted)
      ? (domMatch || dowMatch)
      : (domMatch && dowMatch);

    if (!dayMatch) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    const h = candidate.getHours();
    if (!matchesCronField(hour, h, 0)) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    const min = candidate.getMinutes();
    if (!matchesCronField(minute, min, 0)) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(candidate);
  }

  throw new Error(`No matching time found in next 4 years for cron: "${expression}"`);
}

interface JobState {
  definition: JobDefinition;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  lastRun: Date | null;
}

export class JobScheduler {
  private jobs: Map<string, JobState> = new Map();
  private db: AnyDb;
  private started = false;
  private stopped = false;

  constructor(db: AnyDb) {
    this.db = db;
  }

  start(definitions: JobDefinition[]): void {
    if (this.started) {
      console.warn("[TSBase] JobScheduler.start() called more than once — ignoring");
      return;
    }

    // Validate before mutating state — prevents stuck started=true on error
    const seen = new Set<string>();
    for (const definition of definitions) {
      if (seen.has(definition.name)) {
        throw new Error(`[TSBase] Duplicate job name: "${definition.name}"`);
      }
      seen.add(definition.name);
    }

    this.started = true;
    this.stopped = false; // reset so the scheduler can be restarted after stop()

    for (const definition of definitions) {
      const state: JobState = {
        definition,
        timer: null,
        running: false,
        lastRun: null,
      };
      this.jobs.set(definition.name, state);
      this.scheduleNext(state);
    }
  }

  private scheduleNext(state: JobState): void {
    if (this.stopped) return;

    const now = new Date();
    let next: Date;
    try {
      next = nextCronTime(state.definition.schedule, now);
    } catch (err) {
      console.error(`[TSBase] Invalid cron expression for job "${state.definition.name}":`, err);
      return;
    }

    const delay = next.getTime() - Date.now();
    state.timer = setTimeout(() => this.runJob(state, next), delay);
  }

  private async runJob(state: JobState, scheduledAt: Date): Promise<void> {
    if (state.running) {
      console.warn(
        `[TSBase] Job "${state.definition.name}" is still running from previous tick — skipping`,
      );
      this.scheduleNext(state);
      return;
    }

    // DST fall-back guard: skip if we already ran at or after this scheduled time
    if (state.lastRun !== null && state.lastRun >= scheduledAt) {
      this.scheduleNext(state);
      return;
    }

    state.running = true;
    state.lastRun = scheduledAt;

    try {
      await state.definition.run({ db: this.db });
    } catch (err) {
      console.error(`[TSBase] Job "${state.definition.name}" failed:`, err);
    } finally {
      state.running = false;
    }

    // Do not reschedule if stop() was called while the job was in-flight
    if (!this.stopped) {
      this.scheduleNext(state);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.jobs.values()) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.jobs.clear();
    this.started = false;
  }
}
