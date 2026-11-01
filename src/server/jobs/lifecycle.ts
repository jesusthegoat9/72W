import type { Job, JobStatus } from "../db/types";

/** Allowed state machine. `processing -> queued` is a scheduled retry. */
export const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["processing"],
  processing: ["completed", "failed", "queued"],
  completed: [],
  failed: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`invalid job transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Exponential backoff: base, 2*base, 4*base ... */
export function backoffSeconds(attempt: number, baseSeconds: number): number {
  return baseSeconds * 2 ** Math.max(attempt - 1, 0);
}

export type FailureOutcome =
  | { status: "queued"; next_attempt_at: string }
  | { status: "failed"; next_attempt_at: null };

/**
 * Decides what happens after a processing job errors: retry later while
 * attempts remain and the error is retryable, otherwise fail permanently.
 */
export function resolveFailure(job: Pick<Job, "attempts" | "max_attempts">, now: Date, baseBackoffSeconds: number, retryable = true): FailureOutcome {
  if (!retryable || job.attempts >= job.max_attempts) return { status: "failed", next_attempt_at: null };
  const delay = backoffSeconds(job.attempts, baseBackoffSeconds) * 1000;
  return { status: "queued", next_attempt_at: new Date(now.getTime() + delay).toISOString() };
}

export function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed";
}
