import { describe, expect, it } from "vitest";
import { freshRepos, memoryMedia, testConfig } from "./helpers";
import { JobService } from "@/server/jobs/service";
import { runDispatcher } from "@/server/jobs/dispatcher";
import { MockTextProvider } from "@/server/providers/mock-text";
import { MockVideoProvider } from "@/server/providers/mock-video";
import type { TextGenerationRequest, TextGenerationResult, TextProvider } from "@/server/providers/text";
import { LeaseLostError } from "@/server/repos/jobs";
import { SqliteDatabase } from "@/server/db/sqlite";
import { migrate } from "@/server/db/migrate";
import { createRepos } from "@/server/repos";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A text provider whose calls block until the test releases them, by call index. */
class HeldTextProvider implements TextProvider {
  readonly name = "mock" as const;
  calls = 0;
  private readonly waiters = new Map<number, () => void>();
  private readonly inner = new MockTextProvider();
  async generate(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const index = this.calls++;
    await new Promise<void>((resolve) => this.waiters.set(index, resolve));
    return this.inner.generate(req);
  }
  release(index: number) {
    const r = this.waiters.get(index);
    if (!r) throw new Error(`no held call #${index}`);
    this.waiters.delete(index);
    r();
  }
}

function worker(repos: Awaited<ReturnType<typeof freshRepos>>["repos"], workerId: string, text: TextProvider, extra: { heartbeat?: boolean; leaseSeconds?: number } = {}) {
  return {
    repos,
    media: memoryMedia(),
    config: testConfig({ maxJobsPerRun: 10, retryBackoffSeconds: 0, leaseSeconds: extra.leaseSeconds ?? 0.2 }),
    mocks: { text, video: new MockVideoProvider() },
    workerId,
    heartbeat: extra.heartbeat,
  };
}

describe("worker leases", () => {
  it("regression: a slow provider call is not reclaimed while the worker renews its lease", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const held = new HeldTextProvider();
    const { job } = await svc.enqueue({ agentHandle: "coolantcarla", kind: "text", idempotencyKey: "slow" });
    const contentBefore = await repos.content.count("any");

    const first = runDispatcher(worker(repos, "w1", held));
    await sleep(600); // well past the 200ms lease; the heartbeat has renewed it several times
    const second = await runDispatcher(worker(repos, "w2", held));
    expect(second).toMatchObject({ recovered: 0, claimed: 0, lost: 0 });
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "processing", lease_owner: "w1" });

    held.release(0);
    const r1 = await first;
    expect(r1).toMatchObject({ claimed: 1, completed: 1, lost: 0 });
    expect(held.calls).toBe(1);
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "completed", attempts: 1, lease_owner: null });
    expect(await repos.content.count("any")).toBe(contentBefore + 1);
    expect(await repos.content.getByJobId(job.id)).not.toBeNull();
  });

  it("a worker that cannot renew is reclaimed; its late result is discarded and content stays single", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const held = new HeldTextProvider();
    const { job } = await svc.enqueue({ agentHandle: "vrampire", kind: "text", idempotencyKey: "frozen" });
    const contentBefore = await repos.content.count("any");

    // w1 is alive but cannot reach the database to renew: to everyone else it is dead.
    const first = runDispatcher(worker(repos, "w1", held, { heartbeat: false }));
    await sleep(400); // lease (200ms) lapses with the provider call still open
    const second = runDispatcher(worker(repos, "w2", held));
    await sleep(50);
    expect(held.calls).toBe(2); // the provider call is repeated: that is the documented cost of a lost lease
    held.release(1); // w2's call finishes first
    const r2 = await second;
    expect(r2).toMatchObject({ recovered: 1, claimed: 1, completed: 1, lost: 0 });

    held.release(0); // w1's original call finally returns
    const r1 = await first;
    expect(r1).toMatchObject({ claimed: 1, completed: 0, lost: 1 });

    const final = (await repos.jobs.getById(job.id))!;
    expect(final).toMatchObject({ status: "completed", attempts: 2, lease_owner: null });
    expect(await repos.content.count("any")).toBe(contentBefore + 1);
    const rows = await repos.content.query({ status: "any", limit: 100 });
    expect(rows.filter((c) => c.job_id === job.id).length).toBe(1);
    const trail = (await repos.activity.forJob(job.id)).map((a) => a.type);
    expect(trail).toContain("job.lease_lost");
    expect(trail.filter((t) => t === "job.completed").length).toBe(1);
  });

  it("a genuinely crashed worker is recovered after its lease lapses, not before", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "crash" });
    const now = new Date();
    expect(await repos.jobs.claim(job.id, { owner: "crashed", now: now.toISOString(), until: new Date(now.getTime() + 300).toISOString() })).toBe(true);

    const early = await runDispatcher(worker(repos, "w2", new MockTextProvider()));
    expect(early).toMatchObject({ recovered: 0, claimed: 0 });
    await sleep(350);
    const late = await runDispatcher(worker(repos, "w2", new MockTextProvider()));
    expect(late).toMatchObject({ recovered: 1, claimed: 1, completed: 1 });
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "completed", attempts: 2, last_error: null });
  });

  it("lease renewal, release and fenced updates", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "lease" });
    const now = new Date().toISOString();
    const until = new Date(Date.now() + 1000).toISOString();
    expect(await repos.jobs.claim(job.id, { owner: "a", now, until })).toBe(true);
    const later = new Date(Date.now() + 5000).toISOString();
    expect(await repos.jobs.renewLease(job.id, "a", later)).toBe(true);
    expect((await repos.jobs.getById(job.id))!.lease_expires_at).toBe(later);
    expect(await repos.jobs.renewLease(job.id, "b", later)).toBe(false);
    expect(await repos.jobs.ownsLease(job.id, "a")).toBe(true);
    expect(await repos.jobs.ownsLease(job.id, "b")).toBe(false);
    await expect(repos.jobs.updateOwned(job.id, "b", { last_error: "nope" })).rejects.toThrow(LeaseLostError);
    expect((await repos.jobs.getById(job.id))!.last_error).toBeNull();
    await repos.jobs.updateOwned(job.id, "a", { last_error: "mine" });
    expect((await repos.jobs.getById(job.id))!.last_error).toBe("mine");
    expect(await repos.jobs.releaseLease(job.id, "b")).toBe(false);
    expect(await repos.jobs.releaseLease(job.id, "a")).toBe(true);
    expect(await repos.jobs.renewLease(job.id, "a", later)).toBe(false);
    await expect(repos.jobs.updateOwned(job.id, "a", { last_error: "late" })).rejects.toThrow(LeaseLostError);
  });

  it("concurrent dispatchers each run every job exactly once", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const contentBefore = await repos.content.count("any");
    for (let i = 0; i < 6; i++) await svc.enqueue({ agentHandle: "cablemonk", kind: "text", idempotencyKey: `c${i}`, prompt: `prompt ${i}` });
    const text = new MockTextProvider();
    const results = await Promise.all(["w1", "w2", "w3"].map((id) => runDispatcher(worker(repos, id, text))));
    const total = (k: "claimed" | "completed" | "lost" | "recovered") => results.reduce((n, r) => n + r[k], 0);
    expect(total("claimed")).toBe(6);
    expect(total("completed")).toBe(6);
    expect(total("lost")).toBe(0);
    expect(total("recovered")).toBe(0);
    const jobs = await repos.jobs.list();
    expect(jobs.every((j) => j.status === "completed" && j.attempts === 1 && j.lease_owner === null)).toBe(true);
    expect(await repos.content.count("any")).toBe(contentBefore + 6);
    expect(new Set(jobs.map((j) => j.content_id)).size).toBe(6);
  });

  it("a pending render is handed to the next dispatcher without a second submit", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const video = new MockVideoProvider({ pendingPolls: 1 });
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "video", idempotencyKey: "handoff" });
    const w1 = { ...worker(repos, "w1", new MockTextProvider()), mocks: { text: new MockTextProvider(), video } };
    const w2 = { ...w1, workerId: "w2" };
    expect(await runDispatcher(w1)).toMatchObject({ claimed: 1, pending: 1 });
    const mid = (await repos.jobs.getById(job.id))!;
    expect(mid).toMatchObject({ status: "processing", lease_owner: null });
    expect(mid.provider_ref).toMatch(/^mock_/);
    expect(await runDispatcher(w2)).toMatchObject({ claimed: 0, completed: 1 });
    expect(video.submits).toBe(1);
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "completed", provider_ref: mid.provider_ref });
  });

  it("provider references are recorded once, whoever submitted", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "video", idempotencyKey: "ref-once" });
    expect(await repos.jobs.recordProviderRef(job.id, "pred_first")).toBe(true);
    expect(await repos.jobs.recordProviderRef(job.id, "pred_second")).toBe(false);
    expect((await repos.jobs.getById(job.id))!.provider_ref).toBe("pred_first");
  });
});

describe("migration 0003 on an existing database", () => {
  it("adds lease columns without touching rows, and treats old processing rows as lapsed", async () => {
    const { mkdtemp, copyFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "x86xx-pre3-"));
    for (const f of ["0001_init.sql", "0002_indexes.sql"]) await copyFile(path.join(process.cwd(), "migrations", f), path.join(dir, f));
    const db = new SqliteDatabase(":memory:");
    expect(await migrate(db, dir)).toEqual(["0001_init.sql", "0002_indexes.sql"]);
    const pre = createRepos(db);
    const { seedCatalogue } = await import("@/server/seed");
    await seedCatalogue(pre);
    const agent = (await pre.agents.getByHandle("rackdaddy"))!;
    const cat = (await pre.categories.getBySlug("hot-racks"))!;
    // Rows written by the pre-lease schema: a processing job and its content.
    await db
      .prepare(
        `INSERT INTO generation_jobs (id, agent_id, kind, status, idempotency_key, prompt, params, provider, dry_run, attempts, max_attempts, started_at, created_at, updated_at)
         VALUES ('job_old', ?, 'text', 'processing', 'old', 'p', '{}', 'mock', 1, 1, 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .bind(agent.id)
      .run();
    await pre.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Old Generated", description: "x", jobId: "job_old", source: "generated" });
    const contentBefore = await pre.content.count("any");
    const jobsBefore = await db.prepare("SELECT COUNT(*) AS n FROM generation_jobs").first<{ n: number }>();

    expect(await migrate(db)).toEqual(["0003_leases.sql"]);
    const cols = (await db.prepare("PRAGMA table_info(generation_jobs)").all<{ name: string }>()).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["lease_owner", "lease_expires_at"]));
    expect(await pre.content.count("any")).toBe(contentBefore);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM generation_jobs").first<{ n: number }>()).toEqual(jobsBefore);
    const post = createRepos(db);
    const old = (await post.jobs.getById("job_old"))!;
    expect(old).toMatchObject({ status: "processing", lease_owner: null, lease_expires_at: null });
    expect(await post.content.getByJobId("job_old")).toMatchObject({ title: "Old Generated" });
    // A second content row for the same job is now impossible; the existing one is returned.
    const dup = await post.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Dup", description: "y", jobId: "job_old", source: "generated" });
    expect(dup.title).toBe("Old Generated");
    expect(await post.jobs.recoverStale(new Date().toISOString())).toEqual({ requeued: 1, failed: 0 });
    expect((await post.jobs.getById("job_old"))!.status).toBe("queued");
  });
});
