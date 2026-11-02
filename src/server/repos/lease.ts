import type { SqlValue } from "../db/database";

/** Identifies the job lease a side-effect write must still hold. */
export interface LeaseFence {
  jobId: string;
  owner: string;
}

export class LeaseLostError extends Error {
  constructor(
    readonly jobId: string,
    readonly owner: string,
    readonly reason: string = "another worker holds the job",
  ) {
    super(`job ${jobId}: lease no longer held by ${owner} (${reason})`);
    this.name = "LeaseLostError";
  }
}

/**
 * SQL predicate that is true only while `owner` holds the lease on a job
 * that is still running. Embedded in the same statement as the write it
 * protects (INSERT ... SELECT ... WHERE <fence>, UPDATE ... WHERE <fence>),
 * so ownership and the write are decided together, atomically, on both
 * node:sqlite and D1 (every statement is its own auto-commit transaction
 * and SQLite has a single writer).
 */
export const LEASE_FENCE_SQL = "EXISTS (SELECT 1 FROM generation_jobs WHERE id = ? AND lease_owner = ? AND status = 'processing')";

export function leaseFenceParams(fence: LeaseFence): SqlValue[] {
  return [fence.jobId, fence.owner];
}
