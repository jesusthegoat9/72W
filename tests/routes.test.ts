import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { NAV } from "@/lib/nav";
import { proxy } from "@/proxy";
import { GET as searchGET } from "@/app/api/search/route";
import { GET as jobsGET, POST as jobsPOST } from "@/app/api/jobs/route";
import { GET as jobGET } from "@/app/api/jobs/[id]/route";
import { GET as healthGET } from "@/app/api/health/route";

type Init = { method?: string; body?: string; headers?: Record<string, string>; cookie?: string };
const req = (url: string, init: Init = {}) => {
  const r = new NextRequest(new URL(url, "http://localhost:3000"), { method: init.method, body: init.body, headers: init.headers });
  if (init.cookie) r.cookies.set("session", init.cookie);
  return r;
};

describe("navigation", () => {
  it("every primary nav link has a page", () => {
    const site = path.join(process.cwd(), "src/app/(site)");
    for (const n of NAV) {
      const file = n.href === "/" ? path.join(site, "page.tsx") : path.join(site, n.href.slice(1), "page.tsx");
      expect(existsSync(file), `${n.href} -> ${file}`).toBe(true);
    }
    expect(existsSync(path.join(process.cwd(), "src/app/(app)/dashboard/page.tsx"))).toBe(true);
  });

  it("proxy guards the dashboard and bounces signed-in users off auth pages", () => {
    const toLogin = proxy(req("/dashboard"));
    expect(toLogin.status).toBe(307);
    expect(new URL(toLogin.headers.get("location")!).pathname).toBe("/login");
    expect(new URL(toLogin.headers.get("location")!).searchParams.get("next")).toBe("/dashboard");

    expect(proxy(req("/dashboard", { cookie: "abc" })).headers.get("location")).toBeNull();
    expect(new URL(proxy(req("/login", { cookie: "abc" })).headers.get("location")!).pathname).toBe("/dashboard");
    expect(proxy(req("/explore?q=rack")).headers.get("location")).toBeNull();
  });
});

describe("API routes", () => {
  it("health reports the sqlite backend with live generation off", async () => {
    const body = await (await healthGET()).json();
    expect(body).toMatchObject({ ok: true, backend: "sqlite", liveGeneration: false });
  });

  it("search validates input and returns ranked results", async () => {
    expect((await searchGET(req("/api/search?limit=999"))).status).toBe(400);
    expect((await searchGET(req("/api/search?category=Hot Racks"))).status).toBe(400);
    const ok = await searchGET(req("/api/search?q=coolant&sort=views&limit=3"));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.count).toBeLessThanOrEqual(3);
    expect(body.results.every((r: { title: string; description: string; tags: string[] }) => /coolant/i.test(r.title + r.description + r.tags.join()))).toBe(true);
    expect(body.query).toEqual({ q: "coolant", category: null, sort: "views", limit: 3 });
    expect(body.results[0]).toHaveProperty("agent_handle");
  });

  it("jobs write endpoint requires the configured bearer token", async () => {
    const payload = JSON.stringify({ agentHandle: "rackdaddy", kind: "text", idempotencyKey: "route-1" });
    const noAuth = await jobsPOST(req("/api/jobs", { method: "POST", body: payload }));
    expect(noAuth.status).toBe(401);
    const wrong = await jobsPOST(req("/api/jobs", { method: "POST", body: payload, headers: { authorization: "Bearer nope" } }));
    expect(wrong.status).toBe(401);

    const auth = { authorization: "Bearer test-token", "content-type": "application/json" };
    const created = await jobsPOST(req("/api/jobs", { method: "POST", body: payload, headers: auth }));
    expect(created.status).toBe(201);
    const { job } = await created.json();
    expect(job).toMatchObject({ status: "queued", dryRun: true, provider: "mock" });

    const again = await jobsPOST(req("/api/jobs", { method: "POST", body: payload, headers: auth }));
    expect(again.status).toBe(200);
    expect((await again.json()).job.id).toBe(job.id);

    const bad = await jobsPOST(req("/api/jobs", { method: "POST", body: JSON.stringify({ agentHandle: "ghost", kind: "text" }), headers: auth }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.field).toBe("agentHandle");

    const live = await jobsPOST(req("/api/jobs", { method: "POST", body: JSON.stringify({ agentHandle: "rackdaddy", kind: "text", live: true }), headers: auth }));
    expect(live.status).toBe(429);
    expect((await live.json()).error.message).toMatch(/live generation is disabled/);

    const notJson = await jobsPOST(req("/api/jobs", { method: "POST", body: "{nope", headers: auth }));
    expect(notJson.status).toBe(400);

    const status = await jobGET(req(`/api/jobs/${job.id}`), { params: Promise.resolve({ id: job.id }) });
    expect(status.status).toBe(200);
    expect((await status.json()).activity.map((a: { type: string }) => a.type)).toContain("job.queued");
    expect((await jobGET(req("/api/jobs/job_missing"), { params: Promise.resolve({ id: "job_missing" }) })).status).toBe(404);
    expect((await jobGET(req("/api/jobs/x"), { params: Promise.resolve({ id: "x" }) })).status).toBe(400);

    const list = await jobsGET(req("/api/jobs?status=bogus"));
    expect(list.status).toBe(400);
  });
});

describe("dispatcher endpoint", () => {
  it("is token gated and runs queued jobs with mock providers", async () => {
    const { POST: runPOST } = await import("@/app/api/jobs/run/route");
    expect((await runPOST(req("/api/jobs/run", { method: "POST" }))).status).toBe(401);
    const auth = { authorization: "Bearer test-token", "content-type": "application/json" };
    await jobsPOST(req("/api/jobs", { method: "POST", body: JSON.stringify({ agentHandle: "cablemonk", kind: "text", idempotencyKey: "run-1" }), headers: auth }));
    const res = await runPOST(req("/api/jobs/run?limit=5", { method: "POST", headers: auth }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.liveGeneration).toBe(false);
    expect(body.summary.completed).toBeGreaterThanOrEqual(1);
    expect((await runPOST(req("/api/jobs/run?limit=0", { method: "POST", headers: auth }))).status).toBe(400);
  });
});
