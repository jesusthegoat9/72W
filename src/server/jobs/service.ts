import type { AppConfig } from "../config";
import type { Job, JobKind, JobParams } from "../db/types";
import type { Repos } from "../repos";

export class ValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "ValidationError";
  }
}
export class LimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitExceededError";
  }
}

export interface EnqueueInput {
  agentHandle: string;
  kind: JobKind;
  prompt?: string;
  params?: JobParams;
  idempotencyKey?: string;
  /** Explicit request for a live (paid) run. Still subject to GENERATION_LIVE and daily limits. */
  live?: boolean;
  maxAttempts?: number;
}

export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export class JobService {
  constructor(
    private readonly repos: Repos,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Validates input, enforces the live switch and daily live budget, and
   * inserts a queued job. Re-submitting the same idempotency key returns the
   * existing job instead of creating a duplicate.
   */
  async enqueue(input: EnqueueInput): Promise<{ job: Job; created: boolean }> {
    if (!input.agentHandle || typeof input.agentHandle !== "string") throw new ValidationError("agentHandle is required", "agentHandle");
    if (input.kind !== "text" && input.kind !== "video") throw new ValidationError("kind must be 'text' or 'video'", "kind");
    const agent = await this.repos.agents.getByHandle(input.agentHandle);
    if (!agent) throw new ValidationError(`unknown agent '${input.agentHandle}'`, "agentHandle");

    const params: JobParams = { ...(input.params ?? {}) };
    if (params.categorySlug !== undefined) {
      if (typeof params.categorySlug !== "string") throw new ValidationError("params.categorySlug must be a string", "params.categorySlug");
      if (!(await this.repos.categories.getBySlug(params.categorySlug)))
        throw new ValidationError(`unknown category '${params.categorySlug}'`, "params.categorySlug");
    } else {
      params.categorySlug = agent.style.favouriteCategories[0];
    }
    if (params.resolution !== undefined && params.resolution !== "720p" && params.resolution !== "1080p")
      throw new ValidationError("params.resolution must be '720p' or '1080p'", "params.resolution");
    if (params.durationSeconds !== undefined) {
      const d = Number(params.durationSeconds);
      if (!Number.isInteger(d) || d < 1 || d > 20) throw new ValidationError("params.durationSeconds must be an integer 1-20", "params.durationSeconds");
    }
    const prompt = (input.prompt ?? "").trim() || `Create a new ${params.categorySlug} listing in your voice.`;
    if (prompt.length > 2000) throw new ValidationError("prompt is too long (max 2000 chars)", "prompt");

    const wantsLive = input.live === true && !this.config.dryRunDefault ? true : input.live === true;
    const dryRun = !wantsLive;
    if (!dryRun) {
      if (!this.config.liveGenerationEnabled) throw new LimitExceededError("live generation is disabled (GENERATION_LIVE is off)");
      const used = await this.repos.jobs.countLiveSince(startOfUtcDay(this.now()));
      if (used >= this.config.maxLiveJobsPerDay)
        throw new LimitExceededError(`daily live job limit reached (${used}/${this.config.maxLiveJobsPerDay})`);
    }

    const idempotencyKey = input.idempotencyKey?.trim() || `${agent.handle}:${input.kind}:${params.categorySlug}:${hashPrompt(prompt)}:${dryRun ? "dry" : "live"}`;
    const { job, created } = await this.repos.jobs.insert({
      agentId: agent.id,
      kind: input.kind,
      idempotencyKey,
      prompt,
      params,
      provider: dryRun ? "mock" : input.kind === "text" ? "openrouter" : "pruna",
      dryRun,
      maxAttempts: input.maxAttempts ?? this.config.maxAttempts,
    });
    if (created) {
      await this.repos.activity.log({
        type: "job.queued",
        message: `${agent.name} queued a ${input.kind} job${dryRun ? " (dry run)" : " (LIVE)"}`,
        agentId: agent.id,
        jobId: job.id,
        simulated: dryRun,
        meta: { kind: input.kind, categorySlug: params.categorySlug },
      });
    }
    return { job, created };
  }

  getStatus(id: string): Promise<Job | null> {
    return this.repos.jobs.getById(id);
  }
}

function hashPrompt(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
