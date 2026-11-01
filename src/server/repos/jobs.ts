import type { SqlDatabase, SqlValue } from "../db/database";
import { newId, nowIso } from "../db/ids";
import type { Job, JobKind, JobParams, JobRow, JobStatus, ProviderName } from "../db/types";

export interface NewJob {
  agentId: string;
  kind: JobKind;
  idempotencyKey: string;
  prompt: string;
  params?: JobParams;
  provider: ProviderName;
  dryRun: boolean;
  maxAttempts?: number;
}

/** Thrown when inserting a live job would exceed the daily live budget. */
export class LiveBudgetExceededError extends Error {
  constructor(readonly used: number, readonly max: number) {
    super(`daily live job limit reached (${used}/${max})`);
    this.name = "LiveBudgetExceededError";
  }
}

export interface LiveBudget {
  /** Count live jobs created at or after this ISO timestamp. */
  since: string;
  max: number;
}

export class LeaseLostError extends Error {
  constructor(readonly jobId: string, readonly owner: string) {
    super(`job ${jobId}: lease no longer held by ${owner}`);
    this.name = "LeaseLostError";
  }
}

export interface Lease {
  owner: string;
  now: string;
  until: string;
}

export interface JobPatch {
  status?: JobStatus;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  provider_ref?: string | null;
  attempts?: number;
  last_error?: string | null;
  result?: Record<string, unknown> | null;
  content_id?: string | null;
  next_attempt_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

const PATCHABLE = new Set<keyof JobPatch>(["status", "provider_ref", "attempts", "last_error", "result", "content_id", "next_attempt_at", "started_at", "completed_at", "lease_owner", "lease_expires_at"]);

export function mapJob(row: JobRow): Job {
  const { params, result, dry_run, ...rest } = row;
  return {
    ...rest,
    params: JSON.parse(params) as JobParams,
    result: result ? (JSON.parse(result) as Record<string, unknown>) : null,
    dryRun: dry_run === 1,
  };
}

export class JobsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async getById(id: string): Promise<Job | null> {
    const row = await this.db.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(id).first<JobRow>();
    return row ? mapJob(row) : null;
  }

  async getByIdempotencyKey(key: string): Promise<Job | null> {
    const row = await this.db
      .prepare("SELECT * FROM generation_jobs WHERE idempotency_key = ?")
      .bind(key)
      .first<JobRow>();
    return row ? mapJob(row) : null;
  }

  /**
   * Inserts, or returns the existing job when the idempotency key is taken.
   *
   * For live jobs pass `liveBudget`: the insert is then conditional on the
   * number of live jobs since `since` being below `max`, evaluated inside the
   * same statement, so concurrent callers cannot all slip under the limit.
   * A race on the idempotency key is resolved by the UNIQUE constraint and a
   * re-read, never by a duplicate row.
   */
  async insert(input: NewJob, liveBudget?: LiveBudget): Promise<{ job: Job; created: boolean }> {
    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) return { job: existing, created: false };
    const id = newId("job");
    const ts = nowIso();
    const values: SqlValue[] = [
      id,
      input.agentId,
      input.kind,
      input.idempotencyKey,
      input.prompt,
      JSON.stringify(input.params ?? {}),
      input.provider,
      input.dryRun ? 1 : 0,
      input.maxAttempts ?? 3,
      ts,
      ts,
    ];
    const columns = `(id, agent_id, kind, status, idempotency_key, prompt, params, provider, dry_run, attempts, max_attempts, created_at, updated_at)`;
    const guarded = !input.dryRun && liveBudget;
    const sql = guarded
      ? `INSERT INTO generation_jobs ${columns}
         SELECT ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM generation_jobs WHERE dry_run = 0 AND created_at >= ?) < ?`
      : `INSERT INTO generation_jobs ${columns} VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, ?)`;
    if (guarded) values.push(liveBudget.since, liveBudget.max);
    let changes = 0;
    try {
      changes = (await this.db.prepare(sql).bind(...values).run()).changes;
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err))) throw err;
      const raced = await this.getByIdempotencyKey(input.idempotencyKey);
      if (raced) return { job: raced, created: false };
      throw err;
    }
    if (changes === 0) {
      if (!guarded) throw new Error("job insert affected no rows");
      // Two identical requests racing for the last slot: the loser's guarded
      // insert sees the budget as full, but the job it wanted already exists.
      // Idempotency wins over the budget error, so both callers get that job.
      const raced = await this.getByIdempotencyKey(input.idempotencyKey);
      if (raced) return { job: raced, created: false };
      throw new LiveBudgetExceededError(await this.countLiveSince(liveBudget.since), liveBudget.max);
    }
    return { job: (await this.getById(id))!, created: true };
  }

  async list(opts: { status?: JobStatus; agentId?: string; limit?: number } = {}): Promise<Job[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.agentId) {
      where.push("agent_id = ?");
      params.push(opts.agentId);
    }
    params.push(Math.min(opts.limit ?? 50, 200));
    const rows = await this.db
      .prepare(
        `SELECT * FROM generation_jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(...params)
      .all<JobRow>();
    return rows.map(mapJob);
  }

  /** Jobs ready to run: queued, and either never scheduled or due. Oldest first. */
  async listRunnable(now: string, limit: number): Promise<Job[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM generation_jobs WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(now, limit)
      .all<JobRow>();
    return rows.map(mapJob);
  }

  /**
   * Atomically moves a queued job to processing under `lease.owner`.
   * Returns false if another worker got there first.
   */
  async claim(id: string, lease: Lease): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE generation_jobs SET status = 'processing', attempts = attempts + 1, started_at = ?, updated_at = ?,
           lease_owner = ?, lease_expires_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .bind(lease.now, lease.now, lease.owner, lease.until, id)
      .run();
    return r.changes === 1;
  }

  /**
   * Takes the lease on an in-flight video job (processing with a provider
   * reference) whose lease is free or lapsed, so one dispatcher polls it.
   */
  async acquirePollLease(id: string, lease: Lease): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE generation_jobs SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND provider_ref IS NOT NULL
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .bind(lease.owner, lease.until, lease.now, id, lease.now)
      .run();
    return r.changes === 1;
  }

  /** Extends the lease. False means the worker no longer owns the job and must stop writing. */
  async renewLease(id: string, owner: string, until: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE generation_jobs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'processing'")
      .bind(until, id, owner)
      .run();
    return r.changes === 1;
  }

  /** Gives the lease up (e.g. a render is pending remotely) so any dispatcher may continue later. */
  async releaseLease(id: string, owner: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE generation_jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?")
      .bind(id, owner)
      .run();
    return r.changes === 1;
  }

  /** True while `owner` holds the lease (does not check expiry; renewal failure signals that). */
  async ownsLease(id: string, owner: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS ok FROM generation_jobs WHERE id = ? AND lease_owner = ?")
      .bind(id, owner)
      .first<{ ok: number }>();
    return row !== null;
  }

  /**
   * Fenced write: applies `patch` only while `owner` still holds the lease.
   * A worker that lost its lease gets LeaseLostError and must not retry.
   */
  async updateOwned(id: string, owner: string, patch: JobPatch): Promise<Job> {
    const { sets, params } = this.buildPatch(patch);
    params.push(id, owner);
    const r = await this.db
      .prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ? AND lease_owner = ?`)
      .bind(...params)
      .run();
    if (r.changes !== 1) throw new LeaseLostError(id, owner);
    return (await this.getById(id))!;
  }

  /**
   * Records a remote render reference exactly once, whoever submitted it.
   * Deliberately not fenced: a reference that is not recorded would be an
   * orphaned (and paid) render that a reclaiming worker would re-submit.
   */
  async recordProviderRef(id: string, providerRef: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE generation_jobs SET provider_ref = ?, updated_at = ? WHERE id = ? AND provider_ref IS NULL")
      .bind(providerRef, nowIso(), id)
      .run();
    return r.changes === 1;
  }

  private buildPatch(patch: JobPatch): { sets: string[]; params: SqlValue[] } {
    const sets: string[] = ["updated_at = ?"];
    const params: SqlValue[] = [nowIso()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (!PATCHABLE.has(k as keyof JobPatch)) throw new Error(`job patch: column '${k}' is not updatable`);
      sets.push(`${k} = ?`);
      params.push(k === "result" ? (v === null ? null : JSON.stringify(v)) : (v as SqlValue));
    }
    return { sets, params };
  }

  /** Unfenced update. Use updateOwned from workers; this is for tests and operators. */
  async update(id: string, patch: JobPatch): Promise<Job> {
    const { sets, params } = this.buildPatch(patch);
    params.push(id);
    await this.db.prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
    return (await this.getById(id))!;
  }

  /**
   * Recovers jobs whose worker died: `processing`, no remote reference to
   * poll, and a lease that lapsed (or was never set, for rows that predate
   * leases). A live worker renews its lease, so it is never caught here.
   * Jobs with attempts left go back to the queue; the rest fail.
   */
  async recoverStale(now: string): Promise<{ requeued: number; failed: number }> {
    const where = `status = 'processing' AND provider_ref IS NULL AND (lease_expires_at IS NULL OR lease_expires_at < ?)`;
    const requeued = (
      await this.db
        .prepare(
          `UPDATE generation_jobs SET status = 'queued', next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
             last_error = 'requeued: worker lease lapsed before the job finished', updated_at = ?
           WHERE ${where} AND attempts < max_attempts`,
        )
        .bind(now, now)
        .run()
    ).changes;
    const failed = (
      await this.db
        .prepare(
          `UPDATE generation_jobs SET status = 'failed', completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
             last_error = 'failed: worker lease lapsed with no attempts left', updated_at = ?
           WHERE ${where} AND attempts >= max_attempts`,
        )
        .bind(now, now, now)
        .run()
    ).changes;
    return { requeued, failed };
  }

  /** Number of non-dry-run jobs created since `sinceIso`. Used for the daily live budget. */
  async countLiveSince(sinceIso: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE dry_run = 0 AND created_at >= ?")
      .bind(sinceIso)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const rows = await this.db
      .prepare("SELECT status, COUNT(*) AS n FROM generation_jobs GROUP BY status")
      .all<{ status: JobStatus; n: number }>();
    const out: Record<JobStatus, number> = { queued: 0, processing: 0, completed: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}
