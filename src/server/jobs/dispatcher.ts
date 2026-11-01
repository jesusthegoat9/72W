import type { AppConfig } from "../config";
import type { Job } from "../db/types";
import { ProviderError } from "../providers/errors";
import { defaultMocks, selectProviders, type Providers } from "../providers";
import { parseListing } from "../providers/text";
import type { Repos } from "../repos";
import type { MediaStorage } from "../storage/media";
import { assertTransition, resolveFailure } from "./lifecycle";

export interface DispatcherDeps {
  repos: Repos;
  media: MediaStorage;
  config: AppConfig;
  /** Override mocks (tests). Live providers are always built from config. */
  mocks?: Providers;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface DispatchSummary {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  pending: number;
  skipped: number;
  jobIds: string[];
}

/**
 * Processes due jobs once. Safe to call repeatedly from a CLI loop, a test,
 * or a Cloudflare scheduled handler. Bounded by config.maxJobsPerRun.
 *
 * text job:  prompt -> text provider -> listing -> content row (+ optional video job)
 * video job: prompt -> submit -> poll (across runs) -> download -> media storage -> attach to content
 */
export async function runDispatcher(deps: DispatcherDeps, opts: { limit?: number } = {}): Promise<DispatchSummary> {
  const { repos, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const mocks = deps.mocks ?? defaultMocks();
  const limit = Math.max(1, Math.min(opts.limit ?? config.maxJobsPerRun, config.maxJobsPerRun));
  const summary: DispatchSummary = { claimed: 0, completed: 0, retried: 0, failed: 0, pending: 0, skipped: 0, jobIds: [] };

  // 1. In-flight video jobs waiting on a remote render.
  const polling = (await repos.jobs.list({ status: "processing", limit })).filter((j) => j.kind === "video" && j.provider_ref);
  for (const job of polling) {
    summary.jobIds.push(job.id);
    await settle(job, () => continueVideo(job, selectProviders(config, job.dryRun, mocks)));
  }

  // 2. New or retrying jobs.
  const runnable = await repos.jobs.listRunnable(now().toISOString(), Math.max(limit - polling.length, 0));
  for (const queued of runnable) {
    if (!(await repos.jobs.claim(queued.id, now().toISOString()))) {
      summary.skipped++;
      continue;
    }
    summary.claimed++;
    summary.jobIds.push(queued.id);
    const job = (await repos.jobs.getById(queued.id))!;
    await repos.activity.log({ type: "job.started", message: `Job ${job.id} started (attempt ${job.attempts}/${job.max_attempts})`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun });
    await settle(job, async () => {
      let providers: Providers;
      try {
        providers = selectProviders(config, job.dryRun, mocks);
      } catch (err) {
        // Configuration problems are not retryable: fail fast and loudly.
        throw new ProviderError((err as Error).message, "config", false);
      }
      return job.kind === "text" ? runText(job, providers) : startVideo(job, providers);
    });
  }
  return summary;

  /** Runs a step and records completion, retry or failure. */
  async function settle(job: Job, step: () => Promise<"completed" | "pending">) {
    try {
      const outcome = await step();
      if (outcome === "pending") {
        summary.pending++;
        return;
      }
      assertTransition("processing", "completed");
      await repos.jobs.update(job.id, { status: "completed", completed_at: now().toISOString(), last_error: null, next_attempt_at: null });
      await repos.activity.log({ type: "job.completed", message: `Job ${job.id} completed`, agentId: job.agent_id, jobId: job.id, simulated: job.dryRun });
      summary.completed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof ProviderError ? err.retryable : true;
      const fresh = (await repos.jobs.getById(job.id))!;
      const outcome = resolveFailure(fresh, now(), config.retryBackoffSeconds, retryable);
      assertTransition("processing", outcome.status);
      await repos.jobs.update(job.id, { status: outcome.status, next_attempt_at: outcome.next_attempt_at, last_error: message, ...(outcome.status === "failed" ? { completed_at: now().toISOString() } : {}) });
      await repos.activity.log({
        type: outcome.status === "failed" ? "job.failed" : "job.retry",
        message: outcome.status === "failed" ? `Job ${job.id} failed: ${message}` : `Job ${job.id} will retry at ${outcome.next_attempt_at}: ${message}`,
        agentId: job.agent_id,
        jobId: job.id,
        simulated: job.dryRun,
        meta: { attempts: fresh.attempts, maxAttempts: fresh.max_attempts },
      });
      if (outcome.status === "failed") summary.failed++;
      else summary.retried++;
      log(`job ${job.id} ${outcome.status}: ${message}`);
    }
  }

  async function runText(job: Job, providers: Providers): Promise<"completed"> {
    const agent = await repos.agents.getById(job.agent_id);
    if (!agent) throw new ProviderError("agent not found", "db", false);
    const categorySlug = job.params.categorySlug ?? agent.style.favouriteCategories[0];
    const category = await repos.categories.getBySlug(categorySlug);
    if (!category) throw new ProviderError(`unknown category ${categorySlug}`, "db", false);

    const result = await providers.text.generate({
      systemPrompt: `${agent.system_prompt}\nvoice: ${agent.style.voice}\nquirks: ${agent.style.quirks.join("; ")}\nRespond with a JSON object: {"title": string, "description": string, "tags": string[]}.`,
      userPrompt: `category: ${category.slug}\ncategory description: ${category.description}\nrequest: ${job.prompt}`,
      json: true,
      model: job.params.model,
    });
    const listing = parseListing(result.text);

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
    await repos.jobs.update(job.id, {
      content_id: content.id,
      result: { contentId: content.id, provider: result.provider, model: result.model, usage: result.usage, estimatedCostUsd: result.estimatedCostUsd, simulated: result.simulated },
    });
    await repos.activity.log({ type: "content.created", message: `${agent.name} created "${listing.title}"`, agentId: agent.id, jobId: job.id, contentId: content.id, simulated: result.simulated, meta: { status: content.status } });

    if (job.params.withVideo) {
      const { job: videoJob, created } = await repos.jobs.insert({
        agentId: agent.id,
        kind: "video",
        idempotencyKey: `${job.id}:video`,
        prompt: `${listing.title}. ${listing.description}`,
        params: { contentId: content.id, categorySlug: category.slug, resolution: job.params.resolution ?? config.pruna.resolution, draft: job.params.draft ?? config.pruna.draft, durationSeconds: job.params.durationSeconds ?? config.pruna.durationSeconds },
        provider: job.dryRun ? "mock" : "pruna",
        dryRun: job.dryRun,
        maxAttempts: job.max_attempts,
      });
      if (created) await repos.activity.log({ type: "job.queued", message: `${agent.name} queued a video job for "${listing.title}"`, agentId: agent.id, jobId: videoJob.id, contentId: content.id, simulated: job.dryRun });
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

  async function startVideo(job: Job, providers: Providers): Promise<"completed" | "pending"> {
    const req = videoRequest(job);
    const { providerRef } = await providers.video.submit(req);
    await repos.jobs.update(job.id, { provider_ref: providerRef, result: { estimatedCostUsd: providers.video.estimateCostUsd(req), resolution: req.resolution, draft: req.draft } });
    return continueVideo((await repos.jobs.getById(job.id))!, providers);
  }

  async function continueVideo(job: Job, providers: Providers): Promise<"completed" | "pending"> {
    const poll = await providers.video.poll(job.provider_ref!);
    if (poll.state === "pending") return "pending";
    if (poll.state === "canceled") throw new ProviderError("render was canceled", providers.video.name, false);
    if (poll.state === "failed") throw new ProviderError(poll.error, providers.video.name, poll.retryable);

    const contentId = typeof job.params.contentId === "string" ? job.params.contentId : null;
    const file = await providers.video.download(poll.outputUrl);
    const key = `videos/${contentId ?? job.id}.${file.extension}`;
    await deps.media.put(key, file.bytes, file.contentType);
    if (contentId) await repos.content.attachMedia(contentId, key, videoRequest(job).durationSeconds);
    await repos.jobs.update(job.id, { content_id: contentId, result: { ...(job.result ?? {}), mediaKey: key, contentType: file.contentType, bytes: file.bytes.byteLength, simulated: providers.video.simulated, metadata: poll.metadata ?? null } });
    await repos.activity.log({ type: "media.stored", message: `Stored ${key} (${file.bytes.byteLength} bytes)`, agentId: job.agent_id, jobId: job.id, contentId, simulated: providers.video.simulated });
    return "completed";
  }
}
