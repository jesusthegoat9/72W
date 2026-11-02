import { describe, expect, it } from "vitest";
import { freshRepos, memoryMedia, testConfig } from "./helpers";
import { JobService } from "@/server/jobs/service";
import { runDispatcher } from "@/server/jobs/dispatcher";
import { MockVideoProvider } from "@/server/providers/mock-video";
import { LeaseLostError } from "@/server/repos/lease";
import { MockTextProvider } from "@/server/providers/mock-text";
import { ContentRepo } from "@/server/repos/content";
import type { Repos } from "@/server/repos";
import type { SqlDatabase, SqlStatement, SqlValue } from "@/server/db/database";
import type { TextGenerationRequest, TextGenerationResult, TextProvider } from "@/server/providers/text";

/**
 * FINDING 1: a worker that has lost its lease can still persist a content
 * row. runText() fences the provider result (lease.guard) and the job update
 * (lease.update), but repos.content.insert() between them is an unfenced
 * INSERT into `content`. The reclaiming worker then *adopts* that row via the
 * per-job idempotency (getByJobId / uq_content_job), so the stale worker's
 * output becomes the job's canonical content, published if the job is a dry
 * run. The "job.lease_lost ... its result was discarded" log entry is false.
 *
 * Deterministic schedule (no sleeps; time is injected via `now`):
 *   1. Worker A claims the job at T0 (lease T0+1s, heartbeat off) and runs
 *      the provider immediately; its ownership check passes. A is then
 *      paused on the content INSERT statement itself (after getByJobId
 *      found nothing and a slug was chosen), i.e. right before the write.
 *   2. Worker B runs at T0+5s: recoverStale requeues the lapsed job, B claims
 *      it and is held inside its provider call.
 *   3. A is released: its INSERT runs and commits a row for the job.
 *   4. B is released: ownership check passes, content.insert finds A's row
 *      and returns it, B marks the job completed with A's content.
 */

/** Deferred signal with an external resolver. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A text provider with a recognisable title, optionally held until released. */
class TaggedTextProvider implements TextProvider {
  readonly name = "mock" as const;
  readonly entered = deferred();
  private readonly gate = deferred();
  constructor(private readonly tag: string, private readonly hold = false) {}
  async generate(req: TextGenerationRequest): Promise<TextGenerationResult> {
    void req;
    this.entered.resolve();
    if (this.hold) await this.gate.promise;
    const text = JSON.stringify({ title: `Listing by worker ${this.tag}`, description: `Produced by worker ${this.tag} for the repro.`, tags: ["repro", this.tag] });
    return { text, provider: "mock", model: "mock-listing-v1", usage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 0, simulated: true };
  }
  release() {
    this.gate.resolve();
  }
}

/**
 * Wraps a SqlDatabase so that run() of any statement matching `pattern`
 * signals `entered` and then waits for `release()` before executing. Every
 * other statement passes straight through to the real database.
 */
function gateStatements(db: SqlDatabase, pattern: RegExp) {
  const entered = deferred();
  const gate = deferred();
  const wrap = (stmt: SqlStatement): SqlStatement => ({
    bind: (...values: SqlValue[]) => wrap(stmt.bind(...values)),
    first: (() => stmt.first()) as SqlStatement["first"],
    all: (() => stmt.all()) as SqlStatement["all"],
    run: async () => {
      entered.resolve();
      await gate.promise;
      return stmt.run();
    },
  });
  const gated: SqlDatabase = {
    prepare: (sql: string) => (pattern.test(sql) ? wrap(db.prepare(sql)) : db.prepare(sql)),
    exec: (sql: string) => db.exec(sql),
    batch: (statements: SqlStatement[]) => db.batch(statements),
  };
  return { db: gated, entered: entered.promise, release: () => gate.resolve() };
}

describe("finding 1: stale worker persists content after losing its lease", () => {
  it("a worker that lost its lease must not persist content; the reclaiming worker's row is the job's content", async () => {
    const { db, repos } = await freshRepos();
    const config = testConfig({ leaseSeconds: 1, retryBackoffSeconds: 0 });
    const svc = new JobService(repos, config);
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "finding1", params: { withVideo: true } });
    const contentBefore = await repos.content.count("any");

    const T0 = new Date("2026-11-01T12:00:00.000Z");
    const later = new Date(T0.getTime() + 5_000); // well past A's 1s lease

    // Worker A: alive, cannot renew (heartbeat off), paused on the content INSERT.
    const contentGate = gateStatements(db, /^\s*INSERT\b[\s\S]*?\bINTO content\b/i);
    const reposA: Repos = { ...repos, content: new ContentRepo(contentGate.db) };
    const textA = new TaggedTextProvider("A");
    const runA = runDispatcher({
      repos: reposA,
      media: memoryMedia(),
      config,
      mocks: { text: textA, video: new MockVideoProvider() },
      workerId: "A",
      heartbeat: false,
      now: () => T0,
    });
    await contentGate.entered; // A passed lease.guard's ownership check and is about to INSERT
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "processing", lease_owner: "A", attempts: 1 });

    // Worker B: A's lease has lapsed, so B recovers, reclaims and starts the provider call.
    const textB = new TaggedTextProvider("B", true);
    const runB = runDispatcher({
      repos,
      media: memoryMedia(),
      config,
      mocks: { text: textB, video: new MockVideoProvider() },
      workerId: "B",
      heartbeat: false,
      now: () => later,
    });
    await textB.entered.promise;
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "processing", lease_owner: "B", attempts: 2 });

    // A resumes: it no longer owns the job, so nothing it writes may persist.
    contentGate.release();
    const resultA = await runA;
    expect(resultA).toMatchObject({ claimed: 1, completed: 0, lost: 1 });

    // B finishes normally.
    textB.release();
    const resultB = await runB;
    expect(resultB).toMatchObject({ recovered: 1, claimed: 1, completed: 1, lost: 0 });

    const finalJob = (await repos.jobs.getById(job.id))!;
    expect(finalJob).toMatchObject({ status: "completed", lease_owner: null, attempts: 2 });

    // Exactly one content row for the job, and it must be B's (the lease holder's), not A's.
    expect(await repos.content.count("any")).toBe(contentBefore + 1);
    const rows = (await repos.content.query({ status: "any", limit: 200 })).filter((c) => c.job_id === job.id);
    expect(rows).toHaveLength(1);
    const content = (await repos.content.getByJobId(job.id))!;
    expect(content).not.toBeNull();
    expect(finalJob.content_id).toBe(content.id);
    // BUG: the stale worker's row was persisted (and published, dry run) and adopted by B.
    expect(content.title).toBe("Listing by worker B");
    expect(rows.map((c) => c.title)).not.toContain("Listing by worker A");

    // The chained video job must be built from the lease holder's content as well.
    const chained = await repos.jobs.getByIdempotencyKey(`${job.id}:video`);
    expect(chained).not.toBeNull();
    expect(chained!.params.contentId).toBe(content.id);
    expect(chained!.prompt).toContain("Listing by worker B");

    // Activity: A reports its result as discarded; that must be true. content.created must reference B's content.
    const trail = await repos.activity.forJob(job.id);
    expect(trail.map((a) => a.type)).toContain("job.lease_lost");
    const created = trail.filter((a) => a.type === "content.created");
    expect(created).toHaveLength(1);
    expect(created[0].meta.worker).toBe("B");
    expect(created[0].content_id).toBe(content.id);
  });
});

describe("lease fencing on every side-effect write", () => {
  async function twoOwners() {
    const { db, repos } = await freshRepos();
    const config = testConfig({ leaseSeconds: 1 });
    const svc = new JobService(repos, config);
    const { job } = await svc.enqueue({ agentHandle: "cablemonk", kind: "text", idempotencyKey: "two-owners", params: { withVideo: true } });
    const T0 = new Date("2026-11-01T12:00:00.000Z");
    // A claimed and is still working, but its lease has lapsed from everyone else's point of view.
    expect(await repos.jobs.claim(job.id, { owner: "A", now: T0.toISOString(), until: new Date(T0.getTime() + 1000).toISOString() })).toBe(true);
    const later = new Date(T0.getTime() + 5000).toISOString();
    expect(await repos.jobs.recoverStale(later)).toEqual({ requeued: 1, failed: 0 });
    expect(await repos.jobs.claim(job.id, { owner: "B", now: later, until: new Date(T0.getTime() + 6000).toISOString() })).toBe(true);
    const agent = (await repos.agents.getByHandle("cablemonk"))!;
    const cat = (await repos.categories.getBySlug("cable-management"))!;
    const A = { jobId: job.id, owner: "A" };
    const B = { jobId: job.id, owner: "B" };
    const base = { agentId: agent.id, categoryId: cat.id, jobId: job.id, description: "x", status: "published" as const, source: "generated" as const };
    return { db, repos, config, job, agent, cat, A, B, base };
  }

  it("two concurrent owners: only the current lease holder's writes land, the stale one's are refused without a trace", async () => {
    const { repos, job, agent, A, B, base } = await twoOwners();
    const activityBefore = (await repos.activity.forJob(job.id)).length;
    const contentBefore = await repos.content.count("any");

    await expect(repos.content.insertForJob({ ...base, title: "Stale A" }, A)).rejects.toThrow(LeaseLostError);
    await expect(repos.activity.logOwned({ type: "content.created", message: "A says created", jobId: job.id, agentId: agent.id }, A)).rejects.toThrow(LeaseLostError);
    await expect(repos.jobs.updateOwned(job.id, "A", { last_error: "A was here" })).rejects.toThrow(LeaseLostError);
    await expect(
      repos.jobs.transitionOwned(job.id, "A", { status: "completed" }, [repos.activity.statement({ type: "job.completed", message: "A done", jobId: job.id, agentId: agent.id }, A).statement]),
    ).rejects.toThrow(LeaseLostError);
    await expect(
      repos.jobs.insert({ agentId: agent.id, kind: "video", idempotencyKey: `${job.id}:video`, prompt: "p", provider: "mock", dryRun: true }, { fence: A }),
    ).rejects.toThrow(LeaseLostError);
    await expect(repos.content.getByJobIdOwned(A)).rejects.toThrow(LeaseLostError);

    expect(await repos.content.count("any")).toBe(contentBefore);
    expect((await repos.activity.forJob(job.id)).length).toBe(activityBefore);
    expect(await repos.jobs.getByIdempotencyKey(`${job.id}:video`)).toBeNull();
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "processing", lease_owner: "B", last_error: expect.stringMatching(/lease lapsed/) });

    // The holder's identical sequence succeeds and is fully recorded.
    const { content, created } = await repos.content.insertForJob({ ...base, title: "Holder B" }, B);
    expect(created).toBe(true);
    expect((await repos.content.getByJobIdOwned(B))!.id).toBe(content.id);
    await repos.activity.logOwned({ type: "content.created", message: "B created", jobId: job.id, agentId: agent.id, contentId: content.id }, B);
    await repos.content.attachMediaOwned(content.id, "videos/x.a2.svg", 5, B);
    await expect(repos.content.attachMediaOwned(content.id, "videos/stale.a1.svg", 5, A)).rejects.toThrow(LeaseLostError);
    expect((await repos.content.getById(content.id))!.media_key).toBe("videos/x.a2.svg");
    const chained = await repos.jobs.insert({ agentId: agent.id, kind: "video", idempotencyKey: `${job.id}:video`, prompt: "p", provider: "mock", dryRun: true }, { fence: B });
    expect(chained.created).toBe(true);
    const done = await repos.jobs.transitionOwned(job.id, "B", { status: "completed", lease_owner: null, lease_expires_at: null, content_id: content.id }, [
      repos.activity.statement({ type: "job.completed", message: "B done", jobId: job.id, agentId: agent.id }, B).statement,
    ]);
    expect(done).toMatchObject({ status: "completed", lease_owner: null, content_id: content.id });
    const types = (await repos.activity.forJob(job.id)).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["content.created", "job.completed"]));
    expect(types.filter((t) => t === "job.completed").length).toBe(1);
    // After the terminal transition even B cannot write any more: the fence requires a running job.
    await expect(repos.activity.logOwned({ type: "late", message: "after completion", jobId: job.id, agentId: agent.id }, B)).rejects.toThrow(LeaseLostError);
  });

  it("a valid owner adopts the row a previous lease holder left, and the previous holder cannot touch it", async () => {
    const { repos, job, A, B, base } = await twoOwners();
    // Rewind: pretend A inserted its row while it still held the lease.
    await repos.jobs.update(job.id, { lease_owner: "A" });
    const { content: rowA, created: createdA } = await repos.content.insertForJob({ ...base, title: "Made by A while valid" }, A);
    expect(createdA).toBe(true);
    // A dies; B reclaims.
    await repos.jobs.update(job.id, { lease_owner: "B" });
    const { content: adopted, created: createdB } = await repos.content.insertForJob({ ...base, title: "B's own text" }, B);
    expect(createdB).toBe(false);
    expect(adopted.id).toBe(rowA.id);
    expect(adopted.title).toBe("Made by A while valid");
    await expect(repos.content.getByJobIdOwned(A)).rejects.toThrow(LeaseLostError);
    expect((await repos.content.query({ status: "any", limit: 200 })).filter((c) => c.job_id === job.id)).toHaveLength(1);
  });

  it("rollback: a failing statement in a transition batch leaves neither the log line nor the status change", async () => {
    const { repos, job, agent, B } = await twoOwners();
    const before = (await repos.activity.forJob(job.id)).length;
    // The good statement comes FIRST so that only a real transaction can undo it.
    const good = repos.activity.statement({ type: "job.completed", message: "would have landed", jobId: job.id, agentId: agent.id }, B).statement;
    const bad = repos.activity.statement({ type: "job.completed", message: "bad fk", jobId: job.id, agentId: "agt_does_not_exist" }, B).statement;
    await expect(repos.jobs.transitionOwned(job.id, "B", { status: "completed", lease_owner: null }, [good, bad])).rejects.toThrow(/FOREIGN KEY/);
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "processing", lease_owner: "B" });
    expect((await repos.activity.forJob(job.id)).length).toBe(before);
    // The owner can still finish normally afterwards.
    const ok = repos.activity.statement({ type: "job.completed", message: "fine", jobId: job.id, agentId: agent.id }, B).statement;
    expect((await repos.jobs.transitionOwned(job.id, "B", { status: "completed", lease_owner: null }, [ok])).status).toBe("completed");
    expect((await repos.activity.forJob(job.id)).length).toBe(before + 1);
  });

  it("the INSERT itself is fenced: a lease taken between the ownership read and the write leaves no row", async () => {
    const { db, repos, job, A, B, base } = await twoOwners();
    await repos.jobs.update(job.id, { lease_owner: "A" }); // A holds it again for this scenario
    const gate = gateStatements(db, /^\s*INSERT\b[\s\S]*?\bINTO content\b/i);
    const contentA = new ContentRepo(gate.db);
    const attempt = contentA.insertForJob({ ...base, title: "A, late" }, A); // passes the pre-read, pauses on the INSERT
    await gate.entered;
    await repos.jobs.update(job.id, { lease_owner: "B" }); // the lease moves while A's statement is queued
    gate.release();
    await expect(attempt).rejects.toThrow(LeaseLostError);
    expect(await repos.content.getByJobId(job.id)).toBeNull();
    expect((await repos.content.insertForJob({ ...base, title: "B" }, B)).created).toBe(true);
  });

  it("a fence refused on the job.started line counts as lost for that job and the pass continues", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job: stolen } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "stolen" });
    await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "kept" });
    // Another worker takes the first job the instant it is claimed.
    const jobs = new Proxy(repos.jobs, {
      get(target, prop, receiver) {
        if (prop !== "claim") return Reflect.get(target, prop, receiver);
        return async (id: string, lease: Parameters<typeof target.claim>[1]) => {
          const ok = await target.claim(id, lease);
          if (ok && id === stolen.id) await target.update(id, { lease_owner: "thief" });
          return ok;
        };
      },
    });
    const r = await runDispatcher({ repos: { ...repos, jobs }, media: memoryMedia(), config: testConfig(), mocks: { text: new MockTextProvider(), video: new MockVideoProvider() }, workerId: "w1" });
    expect(r).toMatchObject({ claimed: 2, lost: 1, completed: 1 });
    expect((await repos.jobs.getByIdempotencyKey("kept"))!.status).toBe("completed");
    expect((await repos.activity.forJob(stolen.id)).map((a) => a.type)).toEqual(expect.arrayContaining(["job.lease_lost"]));
    expect((await repos.activity.forJob(stolen.id)).map((a) => a.type)).not.toContain("job.started");
  });

  it("content stays a draft until the holder's completion commits it, so a job that never completes shows nothing", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "cablemonk", kind: "text", idempotencyKey: "last-attempt", maxAttempts: 1 });
    const agent = (await repos.agents.getByHandle("cablemonk"))!;
    const cat = (await repos.categories.getBySlug("cable-management"))!;
    await repos.jobs.claim(job.id, { owner: "A", now: "2026-01-01T00:00:00.000Z", until: "2026-01-01T00:01:00.000Z" });
    const A = { jobId: job.id, owner: "A" };
    const { content } = await repos.content.insertForJob({ agentId: agent.id, categoryId: cat.id, jobId: job.id, title: "Draft until done", description: "x", status: "draft", source: "generated" }, A);
    expect(content.status).toBe("draft");
    // A dies for good: no attempts left, so recovery fails the job. Its row must not be public.
    expect(await repos.jobs.recoverStale("2099-01-01T00:00:00.000Z")).toEqual({ requeued: 0, failed: 1 });
    expect((await repos.content.getById(content.id))!.status).toBe("draft");
    expect(await repos.content.query({ q: "Draft until done" })).toEqual([]);
    expect((await repos.jobs.getById(job.id))!.status).toBe("failed");
  });

  it("a dry-run completion publishes in the same transaction; a failed completion publishes nothing", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "coolantcarla", kind: "text", idempotencyKey: "publish-with-completion" });
    const r = await runDispatcher({ repos, media: memoryMedia(), config: testConfig(), mocks: { text: new MockTextProvider(), video: new MockVideoProvider() }, workerId: "w1" });
    expect(r.completed).toBe(1);
    const content = (await repos.content.getByJobId(job.id))!;
    expect(content.status).toBe("published");
    expect(content.published_at).not.toBeNull();
    expect((await repos.activity.forJob(job.id)).find((a) => a.type === "content.created")!.meta.status).toBe("draft");

    // Same transition with the publish statement but a failing extra: nothing is published or completed.
    const { job: job2 } = await svc.enqueue({ agentHandle: "coolantcarla", kind: "text", idempotencyKey: "publish-rolls-back" });
    const now = new Date().toISOString();
    await repos.jobs.claim(job2.id, { owner: "w1", now, until: "2099-01-01T00:00:00.000Z" });
    const agent = (await repos.agents.getByHandle("coolantcarla"))!;
    const cat = (await repos.categories.getBySlug("liquid-cooling"))!;
    const fence = { jobId: job2.id, owner: "w1" };
    const { content: draft } = await repos.content.insertForJob({ agentId: agent.id, categoryId: cat.id, jobId: job2.id, title: "Rolled back", description: "x", status: "draft", source: "generated" }, fence);
    const publish = repos.content.publishStatement(draft.id, now, fence);
    const bad = repos.activity.statement({ type: "job.completed", message: "bad", jobId: job2.id, agentId: "agt_nope" }, fence).statement;
    await expect(repos.jobs.transitionOwned(job2.id, "w1", { status: "completed", lease_owner: null }, [publish, bad])).rejects.toThrow(/FOREIGN KEY/);
    expect((await repos.content.getById(draft.id))!.status).toBe("draft");
    expect((await repos.jobs.getById(job2.id))!.status).toBe("processing");
  });

  it("media keys are per attempt and per worker, so a late upload never replaces the holder's object", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const media = memoryMedia();
    const video = new MockVideoProvider();
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "video", idempotencyKey: "keyed" });
    const r = await runDispatcher({ repos, media, config: testConfig(), mocks: { text: new MockTextProvider(), video }, workerId: "w1" });
    expect(r.completed).toBe(1);
    const done = (await repos.jobs.getById(job.id))!;
    expect(done.result?.mediaKey).toBe(`videos/${job.id}.a1-w1.svg`);
    expect(await media.head(`videos/${job.id}.a1-w1.svg`)).not.toBeNull();
  });
});
