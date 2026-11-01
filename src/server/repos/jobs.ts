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

export interface JobPatch {
  status?: JobStatus;
  provider_ref?: string | null;
  attempts?: number;
  last_error?: string | null;
  result?: Record<string, unknown> | null;
  content_id?: string | null;
  next_attempt_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

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
   * Atomically moves a queued job to processing. Returns false if another
   * worker got there first, so two dispatchers never run the same job.
   */
  async claim(id: string, now: string): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE generation_jobs SET status = 'processing', attempts = attempts + 1, started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .bind(now, now, id)
      .run();
    return r.changes === 1;
  }

  async update(id: string, patch: JobPatch): Promise<Job> {
    const sets: string[] = ["updated_at = ?"];
    const params: SqlValue[] = [nowIso()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(k === "result" ? (v === null ? null : JSON.stringify(v)) : (v as SqlValue));
    }
    params.push(id);
    await this.db.prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
    return (await this.getById(id))!;
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
