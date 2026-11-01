import type { AppConfig } from "../config";
import type { Job } from "../db/types";
import { ProviderError } from "../providers/errors";
import { defaultMocks, selectProviders, type Providers } from "../providers";
import { parseListing } from "../providers/text";
import type { Repos } from "../repos";
import { LeaseLostError, LiveBudgetExceededError, type JobPatch } from "../repos/jobs";
import type { MediaStorage } from "../storage/media";
import { assertTransition, resolveFailure } from "./lifecycle";
import { liveBudgetFor } from "./service";

export { LeaseLostError };

export interface DispatcherDeps {
  repos: Repos;
  media: MediaStorage;
  config: AppConfig;
  /** Override mocks (tests). Live providers are always built from config. */
  mocks?: Providers;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Identity of this dispatcher. Each run gets a random one unless given. */
  workerId?: string;
  /**
   * Renew leases while a provider call is in flight (default true). Tests
   * set false to simulate a worker that is alive but cannot reach the
   * database, which is indistinguishable from a dead one to everyone else.
   */
  heartbeat?: boolean;
}

export interface DispatchSummary {
  /** Jobs whose previous worker's lease lapsed: put back in the queue (or failed) before this pass. */
  recovered: number;
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  pending: number;
  skipped: number;
  /** Jobs this worker finished working on after another worker had taken them over. Nothing was written. */
  lost: number;
  jobIds: string[];
}

/**
 * Processes due jobs once. Safe to call repeatedly from a CLI loop, a test,
 * or a Cloudflare scheduled handler, and safe to run from several workers
 * at once. Bounded by config.maxJobsPerRun.
 *
 * Ownership: a worker claims a job with a lease (`leaseSeconds`) and renews
 * it every third of that while it works. Only a lapsed lease makes a job
 * recoverable, so a slow provider call is never mistaken for a dead worker
 * as long as the worker can still reach the database. Every write to the
 * job is conditional on still holding the lease; a worker that lost it
 * gets LeaseLostError and writes nothing. Content is unique per job, so a
 * late worker's result cannot create a second record.
 *
 * What this does not promise: exactly-once provider calls. A worker that
 * cannot renew (database unreachable) is reclaimed while its provider call
 * is still running, so the call happens twice; only one result is kept.
 * Text calls are harmless to repeat. A video submit is recorded under the
 * job the moment it returns, whoever made it, so a reclaiming worker reuses
 * it rather than paying for another; the remaining window is a worker that
 * dies between submit and record, which Pruna's API gives no key to close.
 *
 * text job:  prompt -> text provider -> listing -> content row (+ optional video job)
 * video job: prompt -> submit -> poll (across runs) -> download -> media storage -> attach to content
 */
export async function runDispatcher(deps: DispatcherDeps, opts: { limit?: number } = {}): Promise<DispatchSummary> {
  const { repos, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const mocks = deps.mocks ?? defaultMocks();
  const owner = deps.workerId ?? `w_${crypto.randomUUID().slice(0, 8)}`;
  const leaseMs = config.leaseSeconds * 1000;
  const limit = Math.max(1, Math.min(opts.limit ?? config.maxJobsPerRun, config.maxJobsPerRun));
  const summary: DispatchSummary = { recovered: 0, claimed: 0, completed: 0, retried: 0, failed: 0, pending: 0, skipped: 0, lost: 0, jobIds: [] };
  const iso = () => now().toISOString();
  const leaseUntil = () => new Date(now().getTime() + leaseMs).toISOString();

  // 0. Orphans: a worker that died (or lost its database) leaves a lapsed lease.
  const stale = await repos.jobs.recoverStale(iso());
  summary.recovered = stale.requeued + stale.failed;
  if (summary.recovered) log(`recovered ${stale.requeued} stale job(s), failed ${stale.failed}`);

  // 1. In-flight video jobs waiting on a remote render: poll under a lease.
  const polling = (await repos.jobs.list({ status: "processing", limit })).filter((j) => j.kind === "video" && j.provider_ref);
  for (const job of polling) {
    if (!(await repos.jobs.acquirePollLease(job.id, { owner, now: iso(), until: leaseUntil() }))) {
      summary.skipped++;
      continue;
    }
    summary.jobIds.push(job.id);
    await settle(job, (lease) => continueVideo((lease.job = job), selectProviders(config, job.dryRun, mocks), lease));
  }

  // 2. New or retrying jobs.
  const runnable = await repos.jobs.listRunnable(iso(), Math.max(limit - polling.length, 0));
  for (const queued of runnable) {
    if (!(await repos.jobs.claim(queued.id, { owner, now: iso(), until: leaseUntil() }))) {
      summary.skipped++;
      continue;
    }
    summary.claimed++;
    summary.jobIds.push(queued.id);
    const job = (await repos.jobs.getById(queued.id))!;
    await repos.activity.log({ type: "job.started", message: `Job ${job.id} started (attempt ${job.attempts}/${job.max_attempts})`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner } });
    await settle(job, async (lease) => {
      let providers: Providers;
      try {
        providers = selectProviders(config, job.dryRun, mocks);
      } catch (err) {
        // Configuration problems are not retryable: fail fast and loudly.
        throw new ProviderError((err as Error).message, "config", false);
      }
      return job.kind === "text" ? runText(job, providers, lease) : startVideo(job, providers, lease);
    });
  }
  return summary;

  /** Runs a step under a lease and records completion, retry, failure, or loss of ownership. */
  async function settle(job: Job, step: (lease: WorkerLease) => Promise<"completed" | "pending">) {
    const lease = createLease(job);
    try {
      const outcome = await step(lease);
      if (outcome === "pending") {
        // Hand the job back so whichever dispatcher runs next can poll it.
        await repos.jobs.releaseLease(job.id, owner);
        summary.pending++;
        return;
      }
      assertTransition("processing", "completed");
      await lease.update({ status: "completed", completed_at: iso(), last_error: null, next_attempt_at: null, lease_owner: null, lease_expires_at: null });
      await repos.activity.log({ type: "job.completed", message: `Job ${job.id} completed`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner } });
      summary.completed++;
    } catch (err) {
      if (err instanceof LeaseLostError) {
        await recordLost(job, err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof ProviderError ? err.retryable : true;
      const fresh = (await repos.jobs.getById(job.id))!;
      const outcome = resolveFailure(fresh, now(), config.retryBackoffSeconds, retryable);
      assertTransition("processing", outcome.status);
      try {
        await lease.update({
          status: outcome.status,
          next_attempt_at: outcome.next_attempt_at,
          last_error: message,
          lease_owner: null,
          lease_expires_at: null,
          ...(outcome.status === "failed" ? { completed_at: iso() } : {}),
        });
      } catch (err2) {
        if (err2 instanceof LeaseLostError) {
          await recordLost(job, err2);
          return;
        }
        throw err2;
      }
      await repos.activity.log({
        type: outcome.status === "failed" ? "job.failed" : "job.retry",
        message: outcome.status === "failed" ? `Job ${job.id} failed: ${message}` : `Job ${job.id} will retry at ${outcome.next_attempt_at}: ${message}`,
        agentId: job.agent_id,
        jobId: job.id,
        simulated: job.dryRun,
        meta: { attempts: fresh.attempts, maxAttempts: fresh.max_attempts, worker: owner },
      });
      if (outcome.status === "failed") summary.failed++;
      else summary.retried++;
      log(`job ${job.id} ${outcome.status}: ${message}`);
    } finally {
      lease.stop();
    }
  }

  async function recordLost(job: Job, err: LeaseLostError) {
    summary.lost++;
    log(`job ${job.id}: lease lost by ${owner}, result discarded`);
    await repos.activity.log({ type: "job.lease_lost", message: `Worker ${err.owner} lost job ${job.id} to another worker; its result was discarded`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner } });
  }

  interface WorkerLease {
    job: Job;
    /** Runs a provider call while renewing the lease, then verifies ownership before returning. */
    guard<T>(fn: () => Promise<T>): Promise<T>;
    assertOwned(): Promise<void>;
    /** Fenced job update. */
    update(patch: JobPatch): Promise<Job>;
    stop(): void;
  }

  function createLease(job: Job): WorkerLease {
    let lost = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    if (deps.heartbeat !== false) {
      timer = setInterval(() => {
        void repos.jobs.renewLease(job.id, owner, leaseUntil()).then((ok) => {
          if (!ok) {
            lost = true;
            stop();
          }
        });
      }, Math.max(10, leaseMs / 3));
      // Never keep a process alive just to renew a lease.
      (timer as { unref?: () => void }).unref?.();
    }
    const assertOwned = async () => {
      if (lost || !(await repos.jobs.ownsLease(job.id, owner))) throw new LeaseLostError(job.id, owner);
    };
    return {
      job,
      stop,
      assertOwned,
      async guard(fn) {
        const value = await fn();
        await assertOwned();
        return value;
      },
      async update(patch) {
        if (lost) throw new LeaseLostError(job.id, owner);
        return repos.jobs.updateOwned(job.id, owner, patch);
      },
    };
  }

  async function runText(job: Job, providers: Providers, lease: WorkerLease): Promise<"completed"> {
    const agent = await repos.agents.getById(job.agent_id);
    if (!agent) throw new ProviderError("agent not found", "db", false);
    const categorySlug = job.params.categorySlug ?? agent.style.favouriteCategories[0];
    const category = await repos.categories.getBySlug(categorySlug);
    if (!category) throw new ProviderError(`unknown category ${categorySlug}`, "db", false);

    const result = await lease.guard(() =>
      providers.text.generate({
        systemPrompt: `${agent.system_prompt}\nvoice: ${agent.style.voice}\nquirks: ${agent.style.quirks.join("; ")}\nRespond with a JSON object: {"title": string, "description": string, "tags": string[]}.`,
        userPrompt: `category: ${category.slug}\ncategory description: ${category.description}\nrequest: ${job.prompt}`,
        json: true,
        model: job.params.model,
      }),
    );
    const listing = parseListing(result.text);

    // One row per job: if another worker already produced it, that row is adopted.
    // Live outputs are never auto-published; dry runs are (clearly flagged as simulated).
    const content = await repos.content.insert({
      agentId: agent.id,
      categoryId: category.id,
      jobId: job.id,
      title: listing.title,
      description: listing.description,
      tags: listing.tags,
      status: job.dryRun ? "published" : "draft",
      source: "generated",
      durationSeconds: job.params.durationSeconds ?? config.pruna.durationSeconds,
    });
    const resultSummary = { contentId: content.id, provider: result.provider, model: result.model, usage: result.usage, estimatedCostUsd: result.estimatedCostUsd, simulated: result.simulated };
    await lease.update({ content_id: content.id, result: resultSummary });
    await repos.activity.log({ type: "content.created", message: `${agent.name} created "${content.title}"`, agentId: agent.id, jobId: job.id, contentId: content.id, simulated: result.simulated, meta: { status: content.status, worker: owner } });

    if (job.params.withVideo) {
      const chained = await chainVideoJob({ repos, config, now }, job, {
        contentId: content.id,
        categorySlug: category.slug,
        prompt: `${content.title}. ${content.description}`,
        title: content.title,
        agentName: agent.name,
      });
      if (chained.skipped) await lease.update({ result: { ...resultSummary, videoJob: `skipped: ${chained.reason}` } });
    }
    return "completed";
  }

  function videoRequest(job: Job) {
    return {
      prompt: job.prompt,
      durationSeconds: job.params.durationSeconds ?? config.pruna.durationSeconds,
      resolution: job.params.resolution ?? config.pruna.resolution,
      draft: job.params.draft ?? config.pruna.draft,
      aspectRatio: "16:9" as const,
    };
  }

  async function startVideo(job: Job, providers: Providers, lease: WorkerLease): Promise<"completed" | "pending"> {
    // A retry after a polling/download error must not submit a second render:
    // the remote job already exists, so pick it up by its reference.
    if (job.provider_ref) return continueVideo(job, providers, lease);
    const req = videoRequest(job);
    const { providerRef } = await providers.video.submit(req);
    // Record the reference first and unconditionally: an unrecorded render is
    // a paid one that a reclaiming worker would submit again.
    const recorded = await repos.jobs.recordProviderRef(job.id, providerRef);
    if (!recorded) {
      await repos.activity.log({ type: "job.duplicate_render", message: `Job ${job.id}: a render had already been submitted by another worker; ${providerRef} is unused`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner, providerRef } });
    }
    await lease.assertOwned();
    await lease.update({ result: { estimatedCostUsd: providers.video.estimateCostUsd(req), resolution: req.resolution, draft: req.draft } });
    return continueVideo((await repos.jobs.getById(job.id))!, providers, lease);
  }

  async function continueVideo(job: Job, providers: Providers, lease: WorkerLease): Promise<"completed" | "pending"> {
    const poll = await lease.guard(() => providers.video.poll(job.provider_ref!));
    if (poll.state === "pending") return "pending";
    if (poll.state === "canceled") throw new ProviderError("render was canceled", providers.video.name, false);
    if (poll.state === "failed") throw new ProviderError(poll.error, providers.video.name, poll.retryable);

    const contentId = typeof job.params.contentId === "string" ? job.params.contentId : null;
    const file = await lease.guard(() => providers.video.download(poll.outputUrl));
    const key = `videos/${contentId ?? job.id}.${file.extension}`;
    // Storing under a fixed key and attaching it are both idempotent.
    await deps.media.put(key, file.bytes, file.contentType);
    if (contentId) await repos.content.attachMedia(contentId, key, videoRequest(job).durationSeconds);
    await lease.update({ content_id: contentId, result: { ...(job.result ?? {}), mediaKey: key, contentType: file.contentType, bytes: file.bytes.byteLength, simulated: providers.video.simulated, metadata: poll.metadata ?? null } });
    await repos.activity.log({ type: "media.stored", message: `Stored ${key} (${file.bytes.byteLength} bytes)`, agentId: job.agent_id, jobId: job.id, contentId, simulated: providers.video.simulated, meta: { worker: owner } });
    return "completed";
  }
}

export interface ChainVideoInput {
  contentId: string;
  categorySlug: string;
  prompt: string;
  title: string;
  agentName: string;
}

/**
 * Queues the follow-up video job for a finished text job. Inherits dry-run
 * status and attempts from the parent. Live chained jobs are subject to the
 * same atomic daily budget as jobs created through the API; when the budget
 * is exhausted the chain is skipped and recorded, never forced.
 */
export async function chainVideoJob(
  ctx: { repos: Repos; config: AppConfig; now?: () => Date },
  parent: Job,
  input: ChainVideoInput,
): Promise<{ skipped: false; job: Job; created: boolean } | { skipped: true; reason: string }> {
  const { repos, config } = ctx;
  const now = ctx.now ?? (() => new Date());
  if (!parent.dryRun && !config.liveGenerationEnabled) {
    const reason = "live generation is disabled";
    await repos.activity.log({ type: "job.skipped", message: `Video job for "${input.title}" skipped: ${reason}`, agentId: parent.agent_id, jobId: parent.id, contentId: input.contentId, simulated: false });
    return { skipped: true, reason };
  }
  try {
    const { job, created } = await repos.jobs.insert(
      {
        agentId: parent.agent_id,
        kind: "video",
        idempotencyKey: `${parent.id}:video`,
        prompt: input.prompt,
        params: {
          contentId: input.contentId,
          categorySlug: input.categorySlug,
          resolution: parent.params.resolution ?? config.pruna.resolution,
          draft: parent.params.draft ?? config.pruna.draft,
          durationSeconds: parent.params.durationSeconds ?? config.pruna.durationSeconds,
        },
        provider: parent.dryRun ? "mock" : "pruna",
        dryRun: parent.dryRun,
        maxAttempts: parent.max_attempts,
      },
      parent.dryRun ? undefined : liveBudgetFor(config, now()),
    );
    if (created) await repos.activity.log({ type: "job.queued", message: `${input.agentName} queued a video job for "${input.title}"`, agentId: parent.agent_id, jobId: job.id, contentId: input.contentId, simulated: parent.dryRun });
    return { skipped: false, job, created };
  } catch (err) {
    if (!(err instanceof LiveBudgetExceededError)) throw err;
    await repos.activity.log({ type: "job.skipped", message: `Video job for "${input.title}" skipped: ${err.message}`, agentId: parent.agent_id, jobId: parent.id, contentId: input.contentId, simulated: false, meta: { used: err.used, max: err.max } });
    return { skipped: true, reason: err.message };
  }
}
