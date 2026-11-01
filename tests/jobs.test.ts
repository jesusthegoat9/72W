import { describe, expect, it } from "vitest";
import { freshRepos, memoryMedia, testConfig } from "./helpers";
import { assertTransition, backoffSeconds, canTransition, resolveFailure } from "@/server/jobs/lifecycle";
import { JobService, LimitExceededError, ValidationError } from "@/server/jobs/service";
import { runDispatcher } from "@/server/jobs/dispatcher";
import { MockTextProvider } from "@/server/providers/mock-text";
import { MockVideoProvider } from "@/server/providers/mock-video";

describe("job lifecycle", () => {
  it("only allows documented transitions", () => {
    expect(canTransition("queued", "processing")).toBe(true);
    expect(canTransition("processing", "completed")).toBe(true);
    expect(canTransition("processing", "queued")).toBe(true);
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("completed", "queued")).toBe(false);
    expect(() => assertTransition("failed", "processing")).toThrow(/invalid job transition/);
  });

  it("retries with exponential backoff until attempts are exhausted", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(backoffSeconds(1, 60)).toBe(60);
    expect(backoffSeconds(3, 60)).toBe(240);
    const retry = resolveFailure({ attempts: 1, max_attempts: 3 }, now, 60);
    expect(retry).toEqual({ status: "queued", next_attempt_at: "2026-11-01T12:01:00.000Z" });
    expect(resolveFailure({ attempts: 3, max_attempts: 3 }, now, 60).status).toBe("failed");
    expect(resolveFailure({ attempts: 1, max_attempts: 3 }, now, 60, false).status).toBe("failed");
  });
});

describe("JobService.enqueue", () => {
  it("validates input with useful errors", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    await expect(svc.enqueue({ agentHandle: "", kind: "text" })).rejects.toThrow(ValidationError);
    await expect(svc.enqueue({ agentHandle: "nobody", kind: "text" })).rejects.toThrow(/unknown agent/);
    await expect(svc.enqueue({ agentHandle: "rackdaddy", kind: "audio" as never })).rejects.toThrow(/kind/);
    await expect(svc.enqueue({ agentHandle: "rackdaddy", kind: "text", params: { categorySlug: "nope" } })).rejects.toThrow(/unknown category/);
    await expect(svc.enqueue({ agentHandle: "rackdaddy", kind: "video", params: { durationSeconds: 99 } })).rejects.toThrow(/durationSeconds/);
    await expect(svc.enqueue({ agentHandle: "rackdaddy", kind: "video", params: { resolution: "4k" as never } })).rejects.toThrow(/resolution/);
  });

  it("is idempotent on the idempotency key", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const a = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "same" });
    const b = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "same" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect((await repos.jobs.list()).length).toBe(1);
    // Derived key: same agent + prompt + category collapses too.
    const c = await svc.enqueue({ agentHandle: "cablemonk", kind: "text", prompt: "hello" });
    const d = await svc.enqueue({ agentHandle: "cablemonk", kind: "text", prompt: "hello" });
    expect(d.job.id).toBe(c.job.id);
  });

  it("defaults to dry run with the mock provider and refuses live runs when disabled", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig({ liveGenerationEnabled: false }));
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text" });
    expect(job.dryRun).toBe(true);
    expect(job.provider).toBe("mock");
    await expect(svc.enqueue({ agentHandle: "rackdaddy", kind: "text", live: true })).rejects.toThrow(LimitExceededError);
  });

  it("enforces the daily live budget when live is enabled", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig({ liveGenerationEnabled: true, maxLiveJobsPerDay: 2 }));
    await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", live: true, idempotencyKey: "l1" });
    await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", live: true, idempotencyKey: "l2" });
    await expect(svc.enqueue({ agentHandle: "rackdaddy", kind: "text", live: true, idempotencyKey: "l3" })).rejects.toThrow(/daily live job limit/);
    const live = await repos.jobs.list();
    expect(live.every((j) => !j.dryRun && j.provider === "openrouter")).toBe(true);
  });
});

describe("dispatcher", () => {
  function deps(repos: Awaited<ReturnType<typeof freshRepos>>["repos"], overrides: Parameters<typeof testConfig>[0] = {}, mocks = { text: new MockTextProvider(), video: new MockVideoProvider() }) {
    return { repos, media: memoryMedia(), config: testConfig(overrides), mocks };
  }

  it("runs a text job into published simulated content", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "coolantcarla", kind: "text", params: { categorySlug: "liquid-cooling" } });
    const summary = await runDispatcher(deps(repos));
    expect(summary).toMatchObject({ claimed: 1, completed: 1, failed: 0, retried: 0 });
    const done = (await repos.jobs.getById(job.id))!;
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(1);
    const content = (await repos.content.getById(done.content_id!))!;
    expect(content.source).toBe("generated");
    expect(content.status).toBe("published");
    expect(content.title.length).toBeGreaterThan(5);
    const trail = (await repos.activity.recent({ limit: 50 })).filter((a) => a.job_id === job.id).map((a) => a.type);
    expect(trail).toEqual(expect.arrayContaining(["job.queued", "job.started", "content.created", "job.completed"]));
    expect((await repos.activity.recent({ limit: 50 })).every((a) => a.simulated)).toBe(true);
  });

  it("chains a video job, polls across runs, stores media and attaches it", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const d = deps(repos, {}, { text: new MockTextProvider(), video: new MockVideoProvider({ pendingPolls: 2 }) });
    await svc.enqueue({ agentHandle: "vrampire", kind: "text", params: { withVideo: true } });

    const r1 = await runDispatcher(d); // text completes, video queued
    expect(r1.completed).toBe(1);
    const r2 = await runDispatcher(d); // video submitted, first poll pending
    expect(r2).toMatchObject({ claimed: 1, pending: 1, completed: 0 });
    let video = (await repos.jobs.list({ status: "processing" }))[0];
    expect(video.kind).toBe("video");
    expect(video.provider_ref).toMatch(/^mock_/);
    const r3 = await runDispatcher(d); // second poll pending
    expect(r3).toMatchObject({ claimed: 0, pending: 1 });
    const r4 = await runDispatcher(d); // third poll succeeds
    expect(r4).toMatchObject({ claimed: 0, pending: 0, completed: 1 });

    video = (await repos.jobs.getById(video.id))!;
    expect(video.status).toBe("completed");
    const content = (await repos.content.getById(video.content_id!))!;
    expect(content.media_key).toBe(`videos/${content.id}.svg`);
    const stored = await d.media.head(content.media_key!);
    expect(stored?.contentType).toBe("image/svg+xml");
    expect(video.result).toMatchObject({ mediaKey: content.media_key, simulated: true, draft: true, resolution: "720p" });
  });

  it("retries a failing job with bounded attempts, then fails it", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const d = deps(repos, {}, { text: new MockTextProvider({ failWhenPromptIncludes: "BOOM" }), video: new MockVideoProvider() });
    const { job } = await svc.enqueue({ agentHandle: "droverclock", kind: "text", prompt: "BOOM", maxAttempts: 2 });

    const r1 = await runDispatcher(d);
    expect(r1).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    let j = (await repos.jobs.getById(job.id))!;
    expect(j.status).toBe("queued");
    expect(j.attempts).toBe(1);
    expect(j.last_error).toMatch(/simulated failure/);
    expect(j.next_attempt_at).not.toBeNull();

    const r2 = await runDispatcher(d);
    expect(r2).toMatchObject({ claimed: 1, retried: 0, failed: 1 });
    j = (await repos.jobs.getById(job.id))!;
    expect(j.status).toBe("failed");
    expect(j.attempts).toBe(2);
    expect(j.completed_at).not.toBeNull();

    const r3 = await runDispatcher(d);
    expect(r3.claimed).toBe(0);
    expect(await repos.content.count("any")).toBe(38);
  });

  it("does not run a job before its next_attempt_at", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const d = deps(repos, { retryBackoffSeconds: 3600 }, { text: new MockTextProvider({ failWhenPromptIncludes: "BOOM" }), video: new MockVideoProvider() });
    await svc.enqueue({ agentHandle: "droverclock", kind: "text", prompt: "BOOM" });
    await runDispatcher(d);
    expect((await runDispatcher(d)).claimed).toBe(0);
  });

  it("claim is exclusive so two dispatchers never process the same job", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text" });
    const now = new Date().toISOString();
    expect(await repos.jobs.claim(job.id, now)).toBe(true);
    expect(await repos.jobs.claim(job.id, now)).toBe(false);
  });

  it("respects maxJobsPerRun", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    for (let i = 0; i < 4; i++) await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: `k${i}` });
    const r = await runDispatcher(deps(repos, { maxJobsPerRun: 2 }));
    expect(r.claimed).toBe(2);
    expect((await repos.jobs.list({ status: "queued" })).length).toBe(2);
  });

  it("fails fast (no retry) when a live job is dispatched with live generation disabled", async () => {
    const { repos } = await freshRepos();
    // Insert a live job directly: the enqueue guard would normally refuse it.
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const { job } = await repos.jobs.insert({ agentId: agent.id, kind: "text", idempotencyKey: "live-x", prompt: "p", provider: "openrouter", dryRun: false });
    const r = await runDispatcher(deps(repos, { liveGenerationEnabled: false }));
    expect(r).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect((await repos.jobs.getById(job.id))!.last_error).toMatch(/Live generation is disabled/);
  });
});
