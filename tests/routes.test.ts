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
import { GET as mediaGET } from "@/app/api/media/[...key]/route";
import { signSession } from "@/lib/session";
import { parseExploreParams } from "@/lib/search-params";
import { PAGE_SIZE } from "@/lib/paging";
import { getServices } from "@/server/container";
import { renderText } from "./helpers";

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

  it("proxy guards the dashboard and only honours signed session cookies", async () => {
    const toLogin = await proxy(req("/dashboard"));
    expect(toLogin.status).toBe(307);
    expect(new URL(toLogin.headers.get("location")!).pathname).toBe("/login");
    expect(new URL(toLogin.headers.get("location")!).searchParams.get("next")).toBe("/dashboard");

    // Any old string used to pass. Now it must be signed with SESSION_SECRET.
    expect(new URL((await proxy(req("/dashboard", { cookie: "abc" }))).headers.get("location")!).pathname).toBe("/login");
    const forged = await signSession("user_1", "not-the-secret");
    expect(new URL((await proxy(req("/dashboard", { cookie: forged }))).headers.get("location")!).pathname).toBe("/login");

    const valid = await signSession("user_1", process.env.SESSION_SECRET!);
    expect((await proxy(req("/dashboard", { cookie: valid }))).headers.get("location")).toBeNull();
    expect(new URL((await proxy(req("/login", { cookie: valid }))).headers.get("location")!).pathname).toBe("/dashboard");
    expect((await proxy(req("/explore?q=rack"))).headers.get("location")).toBeNull();
  });

  it("explore page tolerates repeated and odd query params", async () => {
    expect(parseExploreParams({ q: ["rack", "other"], sort: ["views"], category: ["hot-racks", "x"] })).toEqual({ q: "rack", category: "hot-racks", sort: "views", page: 1 });
    expect(parseExploreParams({ q: "  a".padEnd(200, "b") })).toMatchObject({ q: expect.stringMatching(/^a?b+$/) });
    expect(parseExploreParams({ category: "Hot Racks", sort: "nope" })).toEqual({ q: "", category: undefined, sort: "trending", page: 1 });
    expect(parseExploreParams({})).toEqual({ q: "", category: undefined, sort: "trending", page: 1 });
    expect(parseExploreParams({ page: "3" }).page).toBe(3);
    expect(parseExploreParams({ page: ["2", "9"] }).page).toBe(2);
    for (const bad of ["0", "-1", "abc", "1.5", "1e3", "99999999", ""]) expect(parseExploreParams({ page: bad }).page, bad).toBe(1);

    const { default: ExplorePage } = await import("@/app/(site)/explore/page");
    // `?q=rack&q=rack` arrives as an array; this used to throw on `.trim()`.
    const el = await ExplorePage({ searchParams: Promise.resolve({ q: ["rack", "rack"], sort: ["newest", "views"] }) });
    expect(el).toBeTruthy();
    const { default: CategoryPage } = await import("@/app/(site)/category/[slug]/page");
    expect(await CategoryPage({ params: Promise.resolve({ slug: "hot-racks" }), searchParams: Promise.resolve({ sort: ["views", "newest"] }) })).toBeTruthy();
  });

  it("explore and category pages paginate and clamp out-of-range pages", async () => {
    const { repos } = await getServices();
    const total = await repos.content.countMatching({});
    expect(total).toBeGreaterThan(PAGE_SIZE); // the seed catalogue needs more than one page for this test to mean anything
    const { default: ExplorePage } = await import("@/app/(site)/explore/page");
    const render = async (sp: Record<string, string | string[]>) => renderText(ExplorePage({ searchParams: Promise.resolve(sp) }));
    const p1 = await render({});
    const p2 = await render({ page: "2" });
    const pLast = await render({ page: "9999" });
    expect(p1).toContain(`Showing 1–${PAGE_SIZE} of ${total}`);
    expect(p1).toContain("/explore?page=2");
    expect(p2).toContain(`Showing ${PAGE_SIZE + 1}–${Math.min(2 * PAGE_SIZE, total)} of ${total}`);
    expect(p2).toContain(`Page 2 of ${Math.ceil(total / PAGE_SIZE)}`);
    expect(p2).toContain("← Previous"); // links back to plain /explore, page 1 is the default
    // Beyond the last page shows the last page rather than an empty grid.
    const pages = Math.ceil(total / PAGE_SIZE);
    expect(pLast).toContain(`Page ${pages} of ${pages}`);
    expect(pLast).not.toContain("No videos in this filter");
    // Filters survive the page links.
    const filtered = await render({ q: "rack", sort: "newest", page: "1" });
    expect(filtered).toContain("Results for “rack”");
    if (filtered.includes("Page 1 of") && !filtered.includes("Page 1 of 1")) expect(filtered).toContain("/explore?q=rack&sort=newest&page=2");

    const { default: CategoryPage } = await import("@/app/(site)/category/[slug]/page");
    const catTotal = await repos.content.countMatching({ categorySlug: "hot-racks" });
    const cat = await renderText(CategoryPage({ params: Promise.resolve({ slug: "hot-racks" }), searchParams: Promise.resolve({ page: "7", sort: "views" }) }));
    expect(cat).toContain("Hot Racks");
    if (catTotal > PAGE_SIZE) expect(cat).toContain("/category/hot-racks?sort=views&page=");
    else expect(cat).not.toContain("Page 1 of");
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

  it("media is served only for published content", async () => {
    const { repos, media } = await getServices();
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("hot-racks"))!;
    await media.put("videos/draft-only.svg", "<svg/>", "image/svg+xml");
    await media.put("videos/public.svg", "<svg/>", "image/svg+xml");
    await media.put("videos/orphan.svg", "<svg/>", "image/svg+xml");
    const draft = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Draft With Media", description: "x", status: "draft", mediaKey: "videos/draft-only.svg" });
    const pub = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Public With Media", description: "x", status: "published", mediaKey: "videos/public.svg" });
    const get = (k: string) => mediaGET(req(`/api/media/${k}`), { params: Promise.resolve({ key: k.split("/") }) });
    expect((await get("videos/draft-only.svg")).status).toBe(404);
    expect((await get("videos/orphan.svg")).status).toBe(404);
    expect((await get("videos/public.svg")).status).toBe(200);
    expect((await get("../etc/passwd")).status).toBe(400);
    await repos.content.setStatus(draft.id, "published");
    expect((await get("videos/draft-only.svg")).status).toBe(200);
    await repos.content.setStatus(pub.id, "archived");
    expect((await get("videos/public.svg")).status).toBe(404);
  });

  it("job reads and writes require the configured bearer token", async () => {
    expect((await jobsGET(req("/api/jobs"))).status).toBe(401);
    expect((await jobGET(req("/api/jobs/job_x"), { params: Promise.resolve({ id: "job_x" }) })).status).toBe(401);
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

    const status = await jobGET(req(`/api/jobs/${job.id}`, { headers: auth }), { params: Promise.resolve({ id: job.id }) });
    expect(status.status).toBe(200);
    expect((await status.json()).activity.map((a: { type: string }) => a.type)).toContain("job.queued");
    expect((await jobGET(req("/api/jobs/job_missing", { headers: auth }), { params: Promise.resolve({ id: "job_missing" }) })).status).toBe(404);
    expect((await jobGET(req("/api/jobs/x", { headers: auth }), { params: Promise.resolve({ id: "x" }) })).status).toBe(400);

    expect((await jobsGET(req("/api/jobs?status=bogus", { headers: auth }))).status).toBe(400);
    const list = await jobsGET(req("/api/jobs", { headers: auth }));
    expect(list.status).toBe(200);
    expect((await list.json()).jobs.some((j: { id: string }) => j.id === job.id)).toBe(true);
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

describe("public agent activity", () => {
  it("never reveals draft titles, operational errors or media keys", async () => {
    const { repos, media } = await getServices();
    const agent = (await repos.agents.getByHandle("droverclock"))!;
    const cat = (await repos.categories.getBySlug("overclocked"))!;
    const draftTitle = "SECRET DRAFT: Unreleased Overclock";
    const draft = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: draftTitle, description: "hush", status: "draft", source: "generated", mediaKey: "videos/private-render-key.svg" });
    await media.put("videos/private-render-key.svg", "<svg/>", "image/svg+xml");
    const { job } = await repos.jobs.insert({ agentId: agent.id, kind: "video", idempotencyKey: "priv-1", prompt: "p", provider: "pruna", dryRun: false });
    await repos.activity.log({ type: "job.queued", message: `${agent.name} queued a video job (LIVE)`, agentId: agent.id, jobId: job.id, simulated: false });
    await repos.activity.log({ type: "content.created", message: `${agent.name} created "${draftTitle}"`, agentId: agent.id, jobId: job.id, contentId: draft.id, simulated: false });
    await repos.activity.log({ type: "media.stored", message: "Stored videos/private-render-key.svg (2201 bytes)", agentId: agent.id, jobId: job.id, contentId: draft.id, simulated: false });
    await repos.activity.log({ type: "job.failed", message: "Job failed: Pruna HTTP 402: insufficient credits for key sk-live-123", agentId: agent.id, jobId: job.id, simulated: false, meta: { attempts: 3 } });
    await repos.activity.log({ type: "content.published", message: `Published "${draftTitle}"`, agentId: agent.id, contentId: draft.id, simulated: false });

    const forbidden = [draftTitle, "private-render-key", "Pruna HTTP 402", "sk-live-123", "failed", "Stored videos"];

    const pub = await repos.activity.publicRecent({ agentId: agent.id, limit: 50 });
    const pubText = JSON.stringify(pub);
    for (const f of forbidden) expect(pubText, f).not.toContain(f);
    expect(pub.map((a) => a.type)).toContain("job.queued");
    // Seed publications are public; the draft's own publish event is hidden until it is published.
    expect(pub.filter((a) => a.type === "content.published").length).toBeGreaterThan(0);
    expect(pub.some((a) => a.contentSlug === draft.slug)).toBe(false);
    expect(pub.find((a) => a.type === "job.queued")!.message).toBe("Queued a generation job");

    // The site-wide feed (home page shift log) is the same sanitised query across every agent.
    const site = await repos.activity.publicRecent({ limit: 50 });
    const siteText = JSON.stringify(site);
    for (const f of forbidden) expect(siteText, f).not.toContain(f);
    expect(site.some((a) => a.agentHandle === "droverclock" && a.type === "job.queued")).toBe(true);
    expect(new Set(site.map((a) => a.agentHandle)).size).toBeGreaterThan(1);
    expect(site.every((a) => a.agentName && /^#[0-9a-f]{3,6}$/i.test(a.agentAccent))).toBe(true);
    for (let i = 1; i < site.length; i++) expect(site[i - 1].created_at >= site[i].created_at).toBe(true);
    // Narrowing by type is a subset of the public types and can never widen past them.
    const onlyPublished = await repos.activity.publicRecent({ limit: 50, types: ["content.published"] });
    expect(onlyPublished.length).toBeGreaterThan(0);
    expect(onlyPublished.every((a) => a.type === "content.published" && a.contentSlug)).toBe(true);
    const narrowed = await repos.activity.publicRecent({ limit: 50, types: ["content.published", "job.completed"] });
    expect(narrowed.some((a) => a.type === "job.queued")).toBe(false);
    expect(narrowed.some((a) => a.type === "job.completed")).toBe(true);
    expect(await repos.activity.publicRecent({ limit: 50, types: ["job.failed", "media.stored"] as unknown as ["job.queued"] })).toEqual([]);
    for (const f of forbidden) expect(JSON.stringify(narrowed), f).not.toContain(f);

    const { default: AgentPage } = await import("@/app/(site)/agents/[handle]/page");
    const pageText = await renderText(AgentPage({ params: Promise.resolve({ handle: "droverclock" }) }));
    expect(pageText).toContain("Queued a generation job");
    for (const f of forbidden) expect(pageText, f).not.toContain(f);

    const { default: HomePage } = await import("@/app/(site)/page");
    const homeText = await renderText(HomePage());
    expect(homeText).toContain("Shift log");
    expect(homeText).toContain("finished a generation job");
    expect(homeText).not.toContain("queued a generation job");
    for (const f of forbidden) expect(homeText, f).not.toContain(f);

    // The operator view still has everything.
    const priv = JSON.stringify(await repos.activity.recent({ agentId: agent.id, limit: 50 }));
    expect(priv).toContain(draftTitle);
    expect(priv).toContain("Pruna HTTP 402");
    expect(JSON.stringify(await repos.activity.forJob(job.id)).includes("private-render-key")).toBe(true);

    // Once published, the title becomes public and links to the video.
    await repos.content.setStatus(draft.id, "published");
    const later = await repos.activity.publicRecent({ agentId: agent.id, limit: 50 });
    const published = later.find((a) => a.type === "content.published")!;
    expect(published.message).toBe(`Published "${draftTitle}"`);
    expect(published.contentSlug).toBe(draft.slug);
    expect(JSON.stringify(later)).not.toContain("private-render-key");
  });
});
