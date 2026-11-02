/**
 * Lease heartbeat guarantees (src/server/jobs/dispatcher.ts createLease):
 *   - a renewal that rejects, is refused, or hangs past the lease marks the
 *     lease lost on this side and never leaks an unhandled rejection;
 *   - renewals never overlap (one setTimeout chain, not setInterval);
 *   - stop() waits for a renewal still in flight and schedules nothing after;
 *   - a provider result that arrives after the lease was lost is discarded
 *     without a single write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshRepos, memoryMedia, testConfig } from "./helpers";
import { JobService } from "@/server/jobs/service";
import { runDispatcher } from "@/server/jobs/dispatcher";
import { MockTextProvider } from "@/server/providers/mock-text";
import { MockVideoProvider } from "@/server/providers/mock-video";
import type { TextGenerationRequest, TextGenerationResult, TextProvider } from "@/server/providers/text";
import type { Repos } from "@/server/repos";

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

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Same database, but this worker's `renewLease` is replaced. Every other repo call is untouched. */
function withRenewLease(repos: Repos, renewLease: Repos["jobs"]["renewLease"]): Repos {
  const jobs = new Proxy(repos.jobs, {
    get(target, prop, receiver) {
      if (prop === "renewLease") return renewLease;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...repos, jobs };
}

// leaseSeconds 0.3 -> heartbeat every 100ms (leaseMs / 3).
const LEASE_SECONDS = 0.3;

function worker(repos: Repos, workerId: string, text: TextProvider, now: () => Date) {
  return {
    repos,
    media: memoryMedia(),
    config: testConfig({ maxJobsPerRun: 10, retryBackoffSeconds: 0, leaseSeconds: LEASE_SECONDS }),
    mocks: { text, video: new MockVideoProvider() },
    workerId,
    now,
  };
}

/** Lets Node run its pending-unhandled-rejection pass (it happens after the microtask drain of a macrotask). */
const flushRejections = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("finding 2: heartbeat renewal failures", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("a rejected renewal is handled, and the worker whose renewal failed does not commit after its lease lapsed", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "coolantcarla", kind: "text", idempotencyKey: "heartbeat-reject" });
    const contentBefore = await repos.content.count("any");

    // Controllable wall clock shared by both workers: w1 claims at T0 (lease until T0 + 300ms).
    const clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
    const now = () => new Date(clock.t);

    // w1 can read and write everything except renew its lease: every renewal throws.
    const renewalAttempted = deferred();
    let renewals = 0;
    const w1Repos = withRenewLease(repos, async () => {
      renewals++;
      renewalAttempted.resolve();
      throw new Error("db down");
    });

    const held = new HeldTextProvider();
    const first = runDispatcher(worker(w1Repos, "w1", held, now));

    // The provider call is open past the first heartbeat (100ms): the renewal fires and rejects.
    await renewalAttempted.promise;
    await flushRejections();
    expect(renewals).toBeGreaterThanOrEqual(1);
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "processing", lease_owner: "w1" });

    // Everyone's clock (including w1's own) is now well past w1's un-renewed lease expiry.
    clock.t += 10_000;
    held.release(0);
    const r1 = await first;

    // (1) The heartbeat must never leak a rejection: this is a process-level crash in production.
    expect.soft(unhandled.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);

    // (2) w1 could not renew and its lease lapsed; it must treat the lease as lost and write nothing,
    //     not record itself as the worker that completed the job.
    expect.soft(r1).toMatchObject({ claimed: 1, completed: 0, lost: 1 });
    const afterW1 = (await repos.jobs.getById(job.id))!;
    expect.soft(afterW1).not.toMatchObject({ status: "completed" });
    expect((await repos.activity.forJob(job.id)).map((a) => a.type)).not.toContain("job.completed");

    // The job is then recoverable by any dispatcher that can reach the database, exactly once.
    const r2 = await runDispatcher(worker(repos, "w2", new MockTextProvider(), now));
    expect(r2).toMatchObject({ recovered: 1, claimed: 1, completed: 1, lost: 0 });
    const final = (await repos.jobs.getById(job.id))!;
    expect(final).toMatchObject({ status: "completed", attempts: 2, lease_owner: null });
    expect(await repos.content.count("any")).toBe(contentBefore + 1);
    const trail = (await repos.activity.forJob(job.id)).map((a) => a.type);
    expect(trail.filter((t) => t === "job.completed").length).toBe(1);
    expect(trail).toContain("job.lease_lost");
  });

  it("renewals do not overlap: a slow renewal is not joined by another one while it is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { repos } = await freshRepos();
      const svc = new JobService(repos, testConfig());
      await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "heartbeat-overlap" });

      // Renewals never finish on their own: each one stays in flight until the test releases it.
      let inFlight = 0;
      let maxInFlight = 0;
      let started = 0;
      const pending: Array<(ok: boolean) => void> = [];
      let holdRenewals = true;
      const w1Repos = withRenewLease(repos, () => {
        started++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<boolean>((resolve) => {
          const settle = (ok: boolean) => {
            inFlight--;
            resolve(ok);
          };
          if (holdRenewals) pending.push(settle);
          else settle(true);
        });
      });

      const held = new HeldTextProvider();
      const run = runDispatcher(worker(w1Repos, "w1", held, () => new Date()));
      // Let the claim and the provider call start, then move through 3.5 heartbeat intervals
      // while the first renewal is still pending.
      await vi.advanceTimersByTimeAsync(0);
      expect(held.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(LEASE_SECONDS * 1000 * (3.5 / 3));

      expect(started).toBeGreaterThanOrEqual(1);
      // Exactly one renewal may be in flight at a time: the next one waits for the previous to settle.
      expect(maxInFlight).toBe(1);

      // Release everything so the run can finish; renewals from here on succeed immediately.
      holdRenewals = false;
      for (const settle of pending.splice(0)) settle(true);
      held.release(0);
      await vi.runAllTimersAsync();
      const r = await run;
      expect(r).toMatchObject({ claimed: 1, completed: 1, lost: 0 });
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an in-flight renewal during shutdown is awaited, and no renewal starts after stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { repos } = await freshRepos();
      const svc = new JobService(repos, testConfig());
      const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "shutdown" });
      let renewals = 0;
      let settleRenewal: ((ok: boolean) => void) | null = null;
      const w1Repos = withRenewLease(repos, () => {
        renewals++;
        return new Promise<boolean>((resolve) => {
          settleRenewal = resolve;
        });
      });
      const held = new HeldTextProvider();
      let resolved = false;
      const run = runDispatcher(worker(w1Repos, "w1", held, () => new Date())).then((r) => {
        resolved = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(LEASE_SECONDS * 1000 / 3 + 5); // first renewal fires and stays in flight
      expect(renewals).toBe(1);

      held.release(0); // provider returns; the step completes and settle() calls lease.stop()
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect((await repos.jobs.getById(job.id))!.status).toBe("completed"); // outcome committed by the holder
      expect(resolved).toBe(false); // ...but the run waits for the renewal still in flight

      settleRenewal!(true);
      await vi.advanceTimersByTimeAsync(0);
      const r = await run;
      expect(resolved).toBe(true);
      expect(r).toMatchObject({ claimed: 1, completed: 1, lost: 0 });
      await vi.advanceTimersByTimeAsync(LEASE_SECONDS * 1000 * 3); // long after stop: nothing is rescheduled
      expect(renewals).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a renewal refused by the database marks the lease lost before the provider returns, so the late result is discarded", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "droverclock", kind: "text", idempotencyKey: "refused" });
    const contentBefore = await repos.content.count("any");
    const w1Repos = withRenewLease(repos, async () => false); // the row no longer carries this owner, as far as this worker can tell
    const held = new HeldTextProvider();
    const clock = { t: Date.parse("2026-11-01T12:00:00.000Z") };
    const lostLogged = deferred();
    const first = runDispatcher({
      ...worker(w1Repos, "w1", held, () => new Date(clock.t)),
      log: (m) => {
        if (/another worker holds the job/.test(m)) lostLogged.resolve();
      },
    });
    await lostLogged.promise; // `lost` is set before this line is logged
    await new Promise<void>((r) => setImmediate(r));
    held.release(0);
    const r1 = await first;
    expect(r1).toMatchObject({ claimed: 1, completed: 0, lost: 1 });
    expect(await repos.content.count("any")).toBe(contentBefore);
    expect((await repos.activity.forJob(job.id)).map((a) => a.type)).not.toContain("content.created");
    expect((await repos.activity.forJob(job.id)).find((a) => a.type === "job.lease_lost")!.meta.reason).toMatch(/another worker holds the job/);
    // Nobody actually took the job, so it still sits under w1 until its lease lapses; then anyone can recover it.
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "processing", lease_owner: "w1" });
    clock.t += 10_000;
    const r2 = await runDispatcher(worker(repos, "w2", new MockTextProvider(), () => new Date(clock.t)));
    expect(r2).toMatchObject({ recovered: 1, claimed: 1, completed: 1 });
    expect(unhandled).toEqual([]);
  });

  it("a renewal that never settles is bounded by the lease: stop() cannot hang the run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { repos } = await freshRepos();
      const svc = new JobService(repos, testConfig());
      await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "never-settles" });
      let renewals = 0;
      const w1Repos = withRenewLease(repos, () => {
        renewals++;
        return new Promise<boolean>(() => {});
      });
      const held = new HeldTextProvider();
      let resolved = false;
      const run = runDispatcher(worker(w1Repos, "w1", held, () => new Date())).then((r) => {
        resolved = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(105); // first renewal fires at 100ms and hangs
      expect(renewals).toBe(1);
      held.release(0); // provider returns while ownership is still unquestioned: commits
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false); // waiting on the hung renewal, bounded by leaseMs
      await vi.advanceTimersByTimeAsync(290);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(10); // 100ms + 300ms lease: the timeout fires
      expect(resolved).toBe(true);
      expect(await run).toMatchObject({ claimed: 1, completed: 1, lost: 0 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(renewals).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a provider slower than a hung renewal's timeout finds the lease lost: nothing is written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { repos } = await freshRepos();
      const svc = new JobService(repos, testConfig());
      const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "never-settles-2" });
      const before = await repos.content.count("any");
      const w1Repos = withRenewLease(repos, () => new Promise<boolean>(() => {}));
      const held = new HeldTextProvider();
      const run = runDispatcher(worker(w1Repos, "w1", held, () => new Date()));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500); // renewal at 100ms hangs and times out at 400ms
      held.release(0);
      await vi.runAllTimersAsync();
      expect(await run).toMatchObject({ claimed: 1, completed: 0, lost: 1 });
      expect(await repos.content.count("any")).toBe(before);
      expect((await repos.activity.forJob(job.id)).find((a) => a.type === "job.lease_lost")!.meta.reason).toMatch(/timed out/);
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a renewal rejecting with a non-Error, with a logger that throws, still marks the lease lost and leaks nothing", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "reject-null" });
    const before = await repos.content.count("any");
    const seen = deferred();
    const w1Repos = withRenewLease(repos, () => {
      seen.resolve();
      return Promise.reject(null); // not an Error instance
    });
    const held = new HeldTextProvider();
    const run = runDispatcher({
      ...worker(w1Repos, "w1", held, () => new Date()),
      log: () => {
        throw new Error("logger broke");
      },
    });
    await seen.promise;
    await flushRejections();
    await new Promise<void>((r) => setImmediate(r));
    held.release(0);
    const r = await run;
    expect(r).toMatchObject({ claimed: 1, completed: 0, lost: 1 });
    expect(await repos.content.count("any")).toBe(before);
    expect((await repos.activity.forJob(job.id)).find((a) => a.type === "job.lease_lost")!.meta.reason).toMatch(/renewal failed: null/);
    expect(unhandled).toEqual([]);
  });

  it("a renewal answered after this worker's own completion is ignored, not reported as another worker", async () => {
    const { repos } = await freshRepos();
    const svc = new JobService(repos, testConfig());
    const { job } = await svc.enqueue({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "late-renewal" });
    const renewalIssued = deferred();
    const answer = deferred();
    // The renewal reaches the database only when the test says so (an async database such as D1).
    const w1Repos = withRenewLease(repos, async (id, owner, until) => {
      renewalIssued.resolve();
      await answer.promise;
      return repos.jobs.renewLease(id, owner, until);
    });
    const logs: string[] = [];
    const held = new HeldTextProvider();
    const run = runDispatcher({ ...worker(w1Repos, "w1", held, () => new Date()), log: (m) => logs.push(m) });
    await renewalIssued.promise; // heartbeat in flight
    held.release(0); // provider returns, ownership unquestioned, completion batch commits
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    expect((await repos.jobs.getById(job.id))!).toMatchObject({ status: "completed", lease_owner: null });
    answer.resolve(); // now the renewal lands on a row that no longer carries the lease
    expect(await run).toMatchObject({ completed: 1, lost: 0 });
    expect(logs.some((m) => /another worker holds the job/.test(m))).toBe(false);
    expect(unhandled).toEqual([]);
  });
});
