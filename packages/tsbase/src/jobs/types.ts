import type { AnyDb } from "../core/db-types.ts";

export type JobContext = {
  db: AnyDb;
};

export interface JobDefinition {
  name: string;
  schedule: string;
  run: (ctx: JobContext) => void | Promise<void>;
}

export type Jobs = JobDefinition[];

export function defineJobs(jobs: Jobs): Jobs {
  return jobs;
}
