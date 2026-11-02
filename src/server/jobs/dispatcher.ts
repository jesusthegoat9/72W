import type { AppConfig } from "../config";
import type { SqlStatement } from "../db/database";
import type { Job } from "../db/types";
import { ProviderError } from "../providers/errors";
import { defaultMocks, selectProviders, type Providers } from "../providers";
import { parseListing } from "../providers/text";
import type { Repos } from "../repos";
import type { NewActivity } from "../repos/activity";
import { LiveBudgetExceededError, type JobPatch } from "../repos/jobs";
import { LeaseLostError, type LeaseFence } from "../repos/lease";
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
  /** Jobs this worker could not finish because it no longer held the lease. Nothing was written for them. */
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
 * as long as the worker can still reach the database. A renewal that fails
 * or errors marks the lease lost on this side: ownership can no longer be
 * confirmed, so the worker stops writing.
 *
 * Fencing: every write that is a job outcome (content row, media attach,
 * chained job, activity line, status transition) carries the lease fence in
 * the same SQL statement, so ownership and the write are decided together.
 * Status transitions and their log line run in one batch (a transaction).
 * A worker that lost the lease gets LeaseLostError and nothing it attempted
 * is persisted. Content is unique per job, and a row is only ever written
 * by the lease holder, so a late worker cannot author the job's content.
 *
 * What this does not promise: exactly-once provider calls. A worker that
 * cannot renew is reclaimed while its provider call may still be running,
 * so the call happens twice; only the holder's result is kept. Text calls
 * are cheap to repeat. A video submit is recorded under the job the moment
 * it returns, whoever made it, so a reclaiming worker reuses it rather than
 * paying for another; the remaining window is a worker that dies between
 * submit and record, which Pruna's API gives no idempotency key to close.
 * Stored media is keyed per attempt and per worker, so a late worker's
 * upload lands on its own key and can never replace the object the holder
 * attached; such orphans hold the same bytes and nothing references them.
 *
 * text job:  prompt -> text provider -> listing -> content row (+ optional video job)
 * video job: prompt -> submit -> poll (across runs) -> download -> media storage -> attach to content
 */
export async function runDispatcher(deps: DispatcherDeps, opts: { limit?: number } = {}): Promise<DispatchSummary> {
  const { repos, config } = deps;
  const now = deps.now ?? (() => new Date());
  const userLog = deps.log ?? (() => {});
  // A logger that throws must never turn into a lost lease or an unhandled rejection.
  const log = (msg: string) => {
    try {
      userLog(msg);
    } catch {
      /* ignore */
    }
  };
  const mocks = deps.mocks ?? defaultMocks();
  const owner = deps.workerId ?? `w_${crypto.randomUUID().slice(0, 8)}`;
  const safeOwner = owner.replace(/[^A-Za-z0-9_-]/g, "_");
  // Timers cannot exceed 2^31-1 ms; config clamps leaseSeconds, this is the backstop.
  const leaseMs = Math.min(config.leaseSeconds * 1000, 2_147_483_647);
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
    await settle(job, (lease) => continueVideo(job, providersFor(job), lease));
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
    await settle(job, async (lease) => {
      // Inside the step so that a fence refused here counts as a lost lease
      // for this job and the pass carries on with the others.
      await repos.activity.logOwned(
        { type: "job.started", message: `Job ${job.id} started (attempt ${job.attempts}/${job.max_attempts})`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner } },
        lease.fence,
      );
      const providers = providersFor(job);
      return job.kind === "text" ? runText(job, providers, lease) : startVideo(job, providers, lease);
    });
  }
  return summary;

  /** Providers for a job. Configuration problems are not retryable: fail fast and loudly, on every path. */
  function providersFor(job: Job): Providers {
    try {
      return selectProviders(config, job.dryRun, mocks);
    } catch (err) {
      throw new ProviderError((err as Error).message, "config", false);
    }
  }

  /** Runs a step under a lease and records completion, retry, failure, or loss of ownership. */
  async function settle(job: Job, step: (lease: WorkerLease) => Promise<StepResult>) {
    const lease = createLease(job);
    try {
      const outcome = await step(lease);
      if (outcome.state === "pending") {
        // Hand the job back so whichever dispatcher runs next can poll it.
        await lease.stop();
        await repos.jobs.releaseLease(job.id, owner);
        summary.pending++;
        return;
      }
      assertTransition("processing", "completed");
      // Completion, its log line and any publication commit together.
      const commit = outcome.commit ?? [];
      let commitChanges: number[] = [];
      await lease.transition(
        { status: "completed", completed_at: iso(), last_error: null, next_attempt_at: null, lease_owner: null, lease_expires_at: null },
        { type: "job.completed", message: `Job ${job.id} completed`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner } },
        commit,
        (changes) => {
          commitChanges = changes.slice(0, commit.length);
        },
      );
      summary.completed++;
      if (commitChanges.some((c) => c === 0)) {
        // The job is complete, but a statement that rode along (publication)
        // matched no row: the content was no longer a draft. Say so rather
        // than leaving a completed job with no public content and no trace.
        log(`job ${job.id}: completed, but ${commitChanges.filter((c) => c === 0).length} accompanying statement(s) matched no row (content not published)`);
        try {
          await repos.activity.log({ type: "content.publish_skipped", message: `Job ${job.id} completed but its content was not a draft, so it was not published`, agentId: job.agent_id, jobId: job.id, contentId: job.content_id, simulated: job.dryRun, meta: { worker: owner } });
        } catch (logErr) {
          log(`job ${job.id}: could not record skipped publication: ${(logErr as Error).message}`);
        }
      }
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
        await lease.transition(
          {
            status: outcome.status,
            next_attempt_at: outcome.next_attempt_at,
            last_error: message,
            lease_owner: null,
            lease_expires_at: null,
            ...(outcome.status === "failed" ? { completed_at: iso() } : {}),
          },
          {
            type: outcome.status === "failed" ? "job.failed" : "job.retry",
            message: outcome.status === "failed" ? `Job ${job.id} failed: ${message}` : `Job ${job.id} will retry at ${outcome.next_attempt_at}: ${message}`,
            agentId: job.agent_id,
            jobId: job.id,
            simulated: job.dryRun,
            meta: { attempts: fresh.attempts, maxAttempts: fresh.max_attempts, worker: owner },
          },
        );
      } catch (err2) {
        if (err2 instanceof LeaseLostError) {
          await recordLost(job, err2);
          return;
        }
        throw err2;
      }
      if (outcome.status === "failed") summary.failed++;
      else summary.retried++;
      log(`job ${job.id} ${outcome.status}: ${message}`);
    } finally {
      await lease.stop();
    }
  }

  /** The lease is gone: count it, and say so if the database will take the note. Never throws. */
  async function recordLost(job: Job, err: LeaseLostError) {
    summary.lost++;
    log(`job ${job.id}: lease lost by ${owner} (${err.reason}), result discarded`);
    try {
      // Unfenced on purpose: this worker no longer owns the job, and the note
      // is about that. It carries the worker id so it cannot be mistaken for
      // an outcome.
      await repos.activity.log({ type: "job.lease_lost", message: `Worker ${owner} no longer held job ${job.id} (${err.reason}); its result was discarded`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner, reason: err.reason } });
    } catch (logErr) {
      log(`job ${job.id}: could not record lease loss: ${(logErr as Error).message}`);
    }
  }

  /** What a step hands back: pending (hand the job over) or completed, optionally with statements to commit alongside. */
  type StepResult = { state: "pending" } | { state: "completed"; commit?: SqlStatement[] };

  interface WorkerLease {
    readonly fence: LeaseFence;
    /** Runs a provider call while renewing the lease, then verifies ownership before returning. */
    guard<T>(fn: () => Promise<T>): Promise<T>;
    assertOwned(): Promise<void>;
    /** Fenced job update. */
    update(patch: JobPatch): Promise<Job>;
    /** Fenced state transition, its log line and any extra fenced statements, in one transaction. `onResults` gets the extra statements' row counts. */
    transition(patch: JobPatch, activity: NewActivity, extra?: SqlStatement[], onResults?: (changes: number[]) => void): Promise<Job>;
    /** Stops renewing and waits for any renewal still in flight. Idempotent. */
    stop(): Promise<void>;
  }

  function createLease(job: Job): WorkerLease {
    const fence: LeaseFence = { jobId: job.id, owner };
    let lost: string | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    const interval = Math.max(10, Math.floor(leaseMs / 3));

    const renew = async () => {
      // A renewal that errors, or takes longer than the lease itself, leaves
      // ownership unconfirmed: treat it as lost. Never let it reject unobserved.
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const attempt = repos.jobs.renewLease(job.id, owner, leaseUntil());
        const expired = new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), leaseMs);
          (timeout as { unref?: () => void }).unref?.();
        });
        const result = await Promise.race([attempt.then((ok) => (ok ? "ok" : "refused")), expired]);
        // Answered after this worker settled the job itself (the batch cleared
        // the lease): not a loss, nothing to report.
        if (stopped) return;
        if (result === "timeout") {
          lost = "lease renewal timed out";
          attempt.catch(() => {}); // observed; the outcome no longer matters
        } else if (result === "refused") {
          lost = "another worker holds the job";
        }
      } catch (err) {
        // Mark lost FIRST: nothing after this line may stop that from happening.
        lost = "lease renewal failed";
        lost += `: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (timeout !== null) clearTimeout(timeout);
      }
      if (lost) log(`job ${job.id}: ${lost}`);
    };

    const schedule = () => {
      if (stopped || lost) return;
      timer = setTimeout(() => {
        timer = null;
        inFlight = renew()
          .catch(() => {
            lost ??= "lease renewal failed";
          })
          .finally(() => {
            inFlight = null;
            schedule();
          });
      }, interval);
      // Never keep a process alive just to renew a lease.
      (timer as { unref?: () => void }).unref?.();
    };
    if (deps.heartbeat !== false) schedule();

    const stop = async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      // Never leave database work outstanding after the run resolves.
      if (inFlight) await inFlight;
    };

    const assertOwned = async () => {
      if (lost) throw new LeaseLostError(job.id, owner, lost);
      if (!(await repos.jobs.ownsLease(job.id, owner))) throw new LeaseLostError(job.id, owner);
    };

    return {
      fence,
      stop,
      assertOwned,
      async guard(fn) {
        const value = await fn();
        await assertOwned();
        return value;
      },
      async update(patch) {
        if (lost) throw new LeaseLostError(job.id, owner, lost);
        return repos.jobs.updateOwned(job.id, owner, patch);
      },
      async transition(patch, activity, extra = [], onResults) {
        if (lost) throw new LeaseLostError(job.id, owner, lost);
        return repos.jobs.transitionOwned(job.id, owner, patch, [...extra, repos.activity.statement(activity, fence).statement], onResults);
      },
    };
  }

  async function runText(job: Job, providers: Providers, lease: WorkerLease): Promise<StepResult> {
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

    // Fenced insert: the row exists only if this worker still held the lease
    // at the moment of writing. A row left by a previous (then valid) holder
    // of the same job is adopted instead of duplicated. It is written as a
    // draft; a dry run publishes it in the same transaction that completes
    // the job, so a job that never completes never shows content. Live
    // outputs are never auto-published.
    const { content, created } = await repos.content.insertForJob(
      {
        agentId: agent.id,
        categoryId: category.id,
        jobId: job.id,
        title: listing.title,
        description: listing.description,
        tags: listing.tags,
        status: "draft",
        source: "generated",
        durationSeconds: job.params.durationSeconds ?? config.pruna.durationSeconds,
      },
      lease.fence,
    );
    const resultSummary = { contentId: content.id, provider: result.provider, model: result.model, usage: result.usage, estimatedCostUsd: result.estimatedCostUsd, simulated: result.simulated };
    await lease.update({ content_id: content.id, result: resultSummary });
    if (created) {
      await repos.activity.logOwned(
        { type: "content.created", message: `${agent.name} created "${content.title}"`, agentId: agent.id, jobId: job.id, contentId: content.id, simulated: result.simulated, meta: { status: content.status, worker: owner } },
        lease.fence,
      );
    }

    if (job.params.withVideo) {
      const chained = await chainVideoJob({ repos, config, now }, job, {
        contentId: content.id,
        categorySlug: category.slug,
        prompt: `${content.title}. ${content.description}`,
        title: content.title,
        agentName: agent.name,
        fence: lease.fence,
      });
      if (chained.skipped) await lease.update({ result: { ...resultSummary, videoJob: `skipped: ${chained.reason}` } });
    }
    return { state: "completed", commit: job.dryRun ? [repos.content.publishStatement(content.id, iso(), lease.fence)] : [] };
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

  async function startVideo(job: Job, providers: Providers, lease: WorkerLease): Promise<StepResult> {
    // A retry after a polling/download error must not submit a second render:
    // the remote job already exists, so pick it up by its reference.
    if (job.provider_ref) return continueVideo(job, providers, lease);
    const req = videoRequest(job);
    const { providerRef } = await providers.video.submit(req);
    // Record the reference first and unconditionally: an unrecorded render is
    // a paid one that a reclaiming worker would submit again.
    const recorded = await repos.jobs.recordProviderRef(job.id, providerRef);
    await lease.assertOwned();
    if (!recorded) {
      await repos.activity.logOwned(
        { type: "job.duplicate_render", message: `Job ${job.id}: a render had already been submitted by another worker; ${providerRef} is unused`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun, meta: { worker: owner, providerRef } },
        lease.fence,
      );
    }
    await lease.update({ result: { estimatedCostUsd: providers.video.estimateCostUsd(req), resolution: req.resolution, draft: req.draft } });
    return continueVideo((await repos.jobs.getById(job.id))!, providers, lease);
  }

  async function continueVideo(job: Job, providers: Providers, lease: WorkerLease): Promise<StepResult> {
    const poll = await lease.guard(() => providers.video.poll(job.provider_ref!));
    if (poll.state === "pending") return { state: "pending" };
    if (poll.state === "canceled") throw new ProviderError("render was canceled", providers.video.name, false);
    if (poll.state === "failed") throw new ProviderError(poll.error, providers.video.name, poll.retryable);

    const contentId = typeof job.params.contentId === "string" ? job.params.contentId : null;
    const file = await lease.guard(() => providers.video.download(poll.outputUrl));
    // Keyed per attempt AND per worker: a late worker (an earlier attempt,
    // or an earlier holder of the same poll lease) writes a different object,
    // so it can never replace the one the holder attaches. Late objects are
    // orphans of identical bytes for the same render; nothing points at them.
    const key = `videos/${contentId ?? job.id}.a${job.attempts}-${safeOwner}.${file.extension}`;
    await deps.media.put(key, file.bytes, file.contentType);
    if (contentId) await repos.content.attachMediaOwned(contentId, key, videoRequest(job).durationSeconds, lease.fence);
    await lease.update({ content_id: contentId, result: { ...(job.result ?? {}), mediaKey: key, contentType: file.contentType, bytes: file.bytes.byteLength, simulated: providers.video.simulated, metadata: poll.metadata ?? null } });
    await repos.activity.logOwned(
      { type: "media.stored", message: `Stored ${key} (${file.bytes.byteLength} bytes)`, agentId: job.agent_id, jobId: job.id, contentId, simulated: providers.video.simulated, meta: { worker: owner } },
      lease.fence,
    );
    return { state: "completed" };
  }
}

export interface ChainVideoInput {
  contentId: string;
  categorySlug: string;
  prompt: string;
  title: string;
  agentName: string;
  /** When set, the chained job is only created while the parent's lease is held. */
  fence?: LeaseFence;
}

/**
 * Queues the follow-up video job for a finished text job. Inherits dry-run
 * status and attempts from the parent. Live chained jobs are subject to the
 * same atomic daily budget as jobs created through the API; when the budget
 * is exhausted the chain is skipped and recorded, never forced. With a
 * fence, a worker that lost the parent job cannot enqueue anything.
 */
export async function chainVideoJob(
  ctx: { repos: Repos; config: AppConfig; now?: () => Date },
  parent: Job,
  input: ChainVideoInput,
): Promise<{ skipped: false; job: Job; created: boolean } | { skipped: true; reason: string }> {
  const { repos, config } = ctx;
  const now = ctx.now ?? (() => new Date());
  const logEntry = (entry: NewActivity) => (input.fence ? repos.activity.logOwned(entry, input.fence) : repos.activity.log(entry));
  if (!parent.dryRun && !config.liveGenerationEnabled) {
    const reason = "live generation is disabled";
    await logEntry({ type: "job.skipped", message: `Video job for "${input.title}" skipped: ${reason}`, agentId: parent.agent_id, jobId: parent.id, contentId: input.contentId, simulated: false });
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
      { liveBudget: parent.dryRun ? undefined : liveBudgetFor(config, now()), fence: input.fence },
    );
    if (created) await logEntry({ type: "job.queued", message: `${input.agentName} queued a video job for "${input.title}"`, agentId: parent.agent_id, jobId: job.id, contentId: input.contentId, simulated: parent.dryRun });
    return { skipped: false, job, created };
  } catch (err) {
    if (!(err instanceof LiveBudgetExceededError)) throw err;
    await logEntry({ type: "job.skipped", message: `Video job for "${input.title}" skipped: ${err.message}`, agentId: parent.agent_id, jobId: parent.id, contentId: input.contentId, simulated: false, meta: { used: err.used, max: err.max } });
    return { skipped: true, reason: err.message };
  }
}
