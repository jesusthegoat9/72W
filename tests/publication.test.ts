/** Review scratch: seed path ends published; media attached to a draft survives publication; completion with a non-draft row. */
import { describe, expect, it } from "vitest";
import { freshRepos, memoryMedia, testConfig } from "./helpers";
import { seedSimulatedActivity } from "@/server/seed/simulate";
import { JobService } from "@/server/jobs/service";
import { chainVideoJob, runDispatcher } from "@/server/jobs/dispatcher";
import { MockTextProvider } from "@/server/providers/mock-text";
import { MockVideoProvider } from "@/server/providers/mock-video";
import type { Services } from "@/server/container";
import type { Repos } from "@/server/repos";

describe("draft and publish paths", () => {
  it("seedSimulatedActivity still ends with published content (with media for withVideo)", async () => {
    const { repos } = await freshRepos();
    const before = await repos.content.count("published");
    const services = { repos, media: memoryMedia(), config: testConfig() } as unknown as Services;
    await seedSimulatedActivity(services);
    expect(await repos.content.count("published")).toBe(before + 4);
    expect(await repos.content.count("draft")).toBe(0);
    const generated = (await repos.content.query({ status: "any", limit: 200 })).filter((c) => c.source === "generated");
    expect(generated.filter((c) => c.media_key).length).toBe(2);
    expect(generated.every((c) => c.status === "published")).toBe(true);
  });

  it("a chained video job that runs before the parent completes attaches media to the draft; publication keeps it", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "parent", params: { withVideo: true } });
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("full-load"))!;
    const now = "2026-11-01T12:00:00.000Z";
    expect(await repos.jobs.claim(job.id, { owner: "A", now, until: "2099-01-01T00:00:00.000Z" })).toBe(true);
    const fence = { jobId: job.id, owner: "A" };
    const { content } = await repos.content.insertForJob({ agentId: agent.id, categoryId: cat.id, jobId: job.id, title: "Parent draft", description: "d", status: "draft", source: "generated" }, fence);
    const chained = await chainVideoJob({ repos, config: testConfig() }, (await repos.jobs.getById(job.id))!, { contentId: content.id, categorySlug: cat.slug, prompt: "p", title: content.title, agentName: agent.name, fence });
    expect(chained.skipped).toBe(false);
    // Another dispatcher runs the video job while the parent is still processing under A.
    const r = await runDispatcher({ repos, media: memoryMedia(), config: testConfig(), mocks: { text: new MockTextProvider(), video: new MockVideoProvider() }, workerId: "B" });
    expect(r).toMatchObject({ claimed: 1, completed: 1 });
    const mid = (await repos.content.getById(content.id))!;
    expect(mid.status).toBe("draft");
    expect(mid.media_key).toMatch(/^videos\//);
    expect(await repos.content.getPublishedByMediaKey(mid.media_key!)).toBeNull(); // media route 404s while draft
    expect(await repos.content.query({ q: "Parent draft" })).toEqual([]);
    // Parent completes: publish rides in the batch.
    await repos.jobs.transitionOwned(job.id, "A", { status: "completed", lease_owner: null, lease_expires_at: null, content_id: content.id }, [
      repos.content.publishStatement(content.id, now, fence),
      repos.activity.statement({ type: "job.completed", message: "done", jobId: job.id, agentId: agent.id }, fence).statement,
    ]);
    const final = (await repos.content.getById(content.id))!;
    expect(final).toMatchObject({ status: "published", media_key: mid.media_key, published_at: now });
    expect(await repos.content.getPublishedByMediaKey(mid.media_key!)).not.toBeNull();
  });

  it("a completion whose publish matched no row is recorded, not silently swallowed", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "archived-draft" });
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("full-load"))!;
    const now = "2026-11-01T12:00:00.000Z";
    await repos.jobs.claim(job.id, { owner: "A", now, until: "2099-01-01T00:00:00.000Z" });
    const fence = { jobId: job.id, owner: "A" };
    const { content } = await repos.content.insertForJob({ agentId: agent.id, categoryId: cat.id, jobId: job.id, title: "Archived", description: "d", status: "draft", source: "generated" }, fence);
    await repos.content.setStatus(content.id, "archived");
    let riders: number[] = [];
    const done = await repos.jobs.transitionOwned(
      job.id,
      "A",
      { status: "completed", lease_owner: null },
      [repos.content.publishStatement(content.id, now, fence), repos.activity.statement({ type: "job.completed", message: "done", jobId: job.id, agentId: agent.id }, fence).statement],
      (changes) => {
        riders = changes;
      },
    );
    expect(done.status).toBe("completed");
    expect(riders).toEqual([0, 1]); // the publish matched nothing, the log line landed
    expect((await repos.content.getById(content.id))!.status).toBe("archived");
  });

  it("through the dispatcher, a dry-run completion whose content is no longer a draft logs content.publish_skipped", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "archived-mid-flight" });
    // Archive the row the moment it is created, before the completion batch runs.
    const activity = new Proxy(repos.activity, {
      get(target, prop, receiver) {
        if (prop !== "logOwned") return Reflect.get(target, prop, receiver);
        return async (entry: Parameters<typeof target.logOwned>[0], fence: Parameters<typeof target.logOwned>[1]) => {
          const row = await target.logOwned(entry, fence);
          if (entry.type === "content.created" && entry.contentId) await repos.content.setStatus(entry.contentId, "archived");
          return row;
        };
      },
    });
    const logs: string[] = [];
    const r = await runDispatcher({ repos: { ...repos, activity }, media: memoryMedia(), config: testConfig(), mocks: { text: new MockTextProvider(), video: new MockVideoProvider() }, workerId: "w1", log: (m) => logs.push(m) });
    expect(r).toMatchObject({ completed: 1, lost: 0 });
    expect((await repos.content.getByJobId(job.id))!.status).toBe("archived");
    expect((await repos.activity.forJob(job.id)).map((a) => a.type)).toContain("content.publish_skipped");
    expect(logs.some((m) => /matched no row/.test(m))).toBe(true);
  });

  it("a dry-run worker that loses its lease after creating content leaves the row a draft, invisible to the public query", async () => {
    const { repos } = await freshRepos();
    const config = testConfig({ leaseSeconds: 1 });
    const svc = new JobService(repos, config);
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "review-draft", maxAttempts: 1 });
    const publishedBefore = await repos.content.count("published");

    // The lease moves to another worker the moment this worker has logged content.created,
    // i.e. after the insert and before the completion transition.
    const activity = new Proxy(repos.activity, {
      get(target, prop, receiver) {
        if (prop !== "logOwned") return Reflect.get(target, prop, receiver);
        return async (entry: Parameters<typeof target.logOwned>[0], fence: Parameters<typeof target.logOwned>[1]) => {
          const row = await target.logOwned(entry, fence);
          if (entry.type === "content.created") await repos.jobs.update(job.id, { lease_owner: "thief" });
          return row;
        };
      },
    });
    const w1Repos: Repos = { ...repos, activity };
    const T0 = new Date("2026-11-01T12:00:00.000Z");
    const r1 = await runDispatcher({ repos: w1Repos, media: memoryMedia(), config, mocks: { text: new MockTextProvider(), video: new MockVideoProvider() }, workerId: "w1", heartbeat: false, now: () => T0 });
    expect(r1).toMatchObject({ claimed: 1, completed: 0, lost: 1 });

    const content = (await repos.content.getByJobId(job.id))!;
    expect(content).not.toBeNull();
    expect((await repos.jobs.getById(job.id))!.status).toBe("processing");
    // The job never completed: its content must not be public.
    expect(content.status).toBe("draft");
    expect(content.published_at).toBeNull();
    expect(await repos.content.count("published")).toBe(publishedBefore);
    expect((await repos.content.query({ status: "published", limit: 200 })).map((c) => c.id)).not.toContain(content.id);

    // The thief never renews; recovery with no attempts left fails the job for good. Still a draft.
    const later = new Date(T0.getTime() + 60_000);
    const r2 = await runDispatcher({ repos, media: memoryMedia(), config, mocks: { text: new MockTextProvider(), video: new MockVideoProvider() }, workerId: "w2", now: () => later });
    expect(r2).toMatchObject({ recovered: 1, claimed: 0 });
    expect((await repos.jobs.getById(job.id))!.status).toBe("failed");
    expect((await repos.content.getById(content.id))!.status).toBe("draft");
    expect(await repos.content.count("published")).toBe(publishedBefore);
  });
});
