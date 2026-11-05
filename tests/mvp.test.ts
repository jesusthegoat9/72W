import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as agentsGET } from "@/app/api/agents/route";
import { GET as agentGET } from "@/app/api/agents/[handle]/route";
import { GET as mediaGET, MEDIA_HEADERS } from "@/app/api/media/[...key]/route";
import { GET as randomGET } from "@/app/random/route";
import { GET as llmsGET } from "@/app/llms.txt/route";
import sitemap from "@/app/sitemap";
import nextConfig, { SECURITY_HEADERS } from "../next.config";
import { authenticateOperator, isOperatorLoginConfigured, OPERATOR_ID, safeNextPath, sessionCookieOptions } from "@/server/auth/operator";
import { verifySession } from "@/lib/session";
import { LIKES_MAX, parseLikes, serializeLikes, toggleLike } from "@/server/likes";
import { ALLOWED_MEDIA_TYPES, normalizeMediaType } from "@/server/storage/media";
import { toPublicAgent } from "@/server/repos/agents";
import { MockTextProvider } from "@/server/providers/mock-text";
import { MockVideoProvider } from "@/server/providers/mock-video";
import type { VideoDownload } from "@/server/providers/video";
import { runDispatcher } from "@/server/jobs/dispatcher";
import { JobService } from "@/server/jobs/service";
import { getServices } from "@/server/container";
import { freshRepos, memoryMedia, renderText, testConfig } from "./helpers";
import { AGENTS } from "@/server/seed/data";

const req = (url: string) => new NextRequest(new URL(url, "http://localhost:3000"));

describe("operator login", () => {
  const config = { operatorPassword: "correct horse battery staple", sessionSecret: "unit-test-secret" };

  it("issues a verifiable operator session only for the right password and only when configured", async () => {
    expect(isOperatorLoginConfigured({ operatorPassword: null, sessionSecret: "s" })).toBe(false);
    expect(isOperatorLoginConfigured({ operatorPassword: "p", sessionSecret: null })).toBe(false);
    expect(isOperatorLoginConfigured(config)).toBe(true);

    expect(await authenticateOperator("anything", { operatorPassword: null, sessionSecret: null })).toMatchObject({ ok: false, reason: "unconfigured" });
    expect(await authenticateOperator("", config)).toMatchObject({ ok: false, reason: "empty" });
    expect(await authenticateOperator("correct horse battery stapl", config)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await authenticateOperator("correct horse battery staple!", config)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await authenticateOperator("Correct horse battery staple", config)).toMatchObject({ ok: false, reason: "invalid" });

    const ok = await authenticateOperator("correct horse battery staple", config, new Date("2026-11-04T00:00:00Z"));
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    const session = await verifySession(ok.cookie, config.sessionSecret, new Date("2026-11-04T00:00:00Z"));
    expect(session?.userId).toBe(OPERATOR_ID);
    expect(session?.expiresAt.toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(await verifySession(ok.cookie, "another-secret")).toBeNull();
    expect(await verifySession(ok.cookie, config.sessionSecret, new Date("2026-11-12T00:00:00Z"))).toBeNull();
    // The error strings never echo the password or the secret.
    for (const bad of ["", "nope"]) {
      const r = await authenticateOperator(bad, config);
      expect(JSON.stringify(r)).not.toContain(config.operatorPassword);
      expect(JSON.stringify(r)).not.toContain(config.sessionSecret);
    }
    expect(sessionCookieOptions(true)).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });

  it("only follows same-site next paths", () => {
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
    expect(safeNextPath("/dashboard?tab=jobs")).toBe("/dashboard?tab=jobs");
    expect(safeNextPath("/agents/rackdaddy")).toBe("/agents/rackdaddy");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "dashboard", "/login", "/login?next=/x", "/a\u0000b", "/".padEnd(600, "a")]) {
      expect(safeNextPath(bad), bad).toBe("/dashboard");
    }
  });
});

describe("likes", () => {
  it("toggles one like per browser per video, on published content only, and caps the cookie", async () => {
    const { repos } = await freshRepos();
    const [video] = await repos.content.query({ sort: "views", limit: 1 });
    const before = video.likes;

    const liked = await toggleLike(video.id, undefined, repos);
    expect(liked).toMatchObject({ ok: true, liked: true });
    if (!liked.ok) throw new Error("unreachable");
    expect((await repos.content.getCard(video.id))!.likes).toBe(before + 1);
    expect(parseLikes(liked.cookie)).toEqual([video.id]);

    const unliked = await toggleLike(video.id, liked.cookie, repos);
    expect(unliked).toMatchObject({ ok: true, liked: false, cookie: "" });
    expect((await repos.content.getCard(video.id))!.likes).toBe(before);

    expect(await toggleLike("vid_nope; DROP TABLE content", undefined, repos)).toMatchObject({ ok: false });
    expect(await toggleLike("vid_00000000000000000000", undefined, repos)).toMatchObject({ ok: false, error: "video not found" });

    const agent = (await repos.agents.getByHandle("cablemonk"))!;
    const cat = (await repos.categories.getBySlug("cable-management"))!;
    const draft = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Unreleased", description: "hush hush hush", status: "draft" });
    expect(await toggleLike(draft.id, undefined, repos)).toMatchObject({ ok: false });
    expect((await repos.content.getCard(draft.id))!.likes).toBe(0);

    // Never below zero even with a stale cookie that claims a like the row no longer has.
    const zero = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Zero likes", description: "a fresh upload", status: "published", likes: 0 });
    const stale = serializeLikes([zero.id]);
    expect(await toggleLike(zero.id, stale, repos)).toMatchObject({ ok: true, liked: false });
    expect((await repos.content.getCard(zero.id))!.likes).toBe(0);

    const many = Array.from({ length: LIKES_MAX + 50 }, (_, i) => `vid_${String(i).padStart(20, "0")}`);
    const parsed = parseLikes(serializeLikes(many));
    expect(parsed.length).toBe(LIKES_MAX);
    expect(parsed[0]).toBe(many[50]); // oldest fall off first
    expect(parseLikes("garbage.vid_ok0000000000000000000.<script>")).toEqual(["vid_ok0000000000000000000"]);
  });
});

describe("media safety", () => {
  it("normalises content types against the allow list", () => {
    expect(normalizeMediaType("video/mp4")).toBe("video/mp4");
    expect(normalizeMediaType("Video/MP4; codecs=avc1")).toBe("video/mp4");
    expect(normalizeMediaType("image/svg+xml; charset=utf-8")).toBe("image/svg+xml");
    for (const bad of ["text/html", "application/javascript", "application/x-sh", "application/octet-stream", "", null, undefined, "video/mp4x"]) {
      expect(normalizeMediaType(bad), String(bad)).toBeNull();
    }
    expect(ALLOWED_MEDIA_TYPES).not.toContain("text/html");
  });

  it("serves allowed types inline with nosniff and an inert CSP, and anything else as a download", async () => {
    const { repos, media } = await getServices();
    const agent = (await repos.agents.getByHandle("vrampire"))!;
    const cat = (await repos.categories.getBySlug("big-memory"))!;
    const svg = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Poster test", description: "a poster for the test", status: "published", mediaKey: "videos/test-poster.svg" });
    await media.put("videos/test-poster.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "image/svg+xml");
    const get = (k: string) => mediaGET(req(`/api/media/${k}`), { params: Promise.resolve({ key: k.split("/") }) });

    const res = await get("videos/test-poster.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(MEDIA_HEADERS["content-security-policy"]).not.toContain("script-src");
    expect(svg.media_key).toBe("videos/test-poster.svg");

    await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Weird blob", description: "a blob for the test", status: "published", mediaKey: "videos/test-blob.bin" });
    await media.put("videos/test-blob.bin", "#!/bin/sh\necho hi", "application/x-sh");
    const blob = await get("videos/test-blob.bin");
    expect(blob.status).toBe(200);
    expect(blob.headers.get("content-type")).toBe("application/octet-stream");
    expect(blob.headers.get("content-disposition")).toBe("attachment");
  });

  it("fails a video job whose provider returns an unsupported media type instead of storing it", async () => {
    const { repos } = await freshRepos();
    const media = memoryMedia();
    const config = testConfig();
    class ShellVideo extends MockVideoProvider {
      override async download(): Promise<VideoDownload> {
        return { bytes: new TextEncoder().encode("#!/bin/sh"), contentType: "application/x-sh", extension: "sh" };
      }
    }
    const { job } = await new JobService(repos, config).enqueue({ agentHandle: "droverclock", kind: "text", params: { withVideo: true }, idempotencyKey: "media-type-1" });
    const mocks = { text: new MockTextProvider(), video: new ShellVideo() };
    await runDispatcher({ repos, media, config, mocks, workerId: "w1" });
    const second = await runDispatcher({ repos, media, config, mocks, workerId: "w1" });
    expect(second.failed).toBe(1);
    const videoJob = (await repos.jobs.list({ limit: 20 })).find((j) => j.idempotency_key === `${job.id}:video`)!;
    expect(videoJob.status).toBe("failed");
    expect(videoJob.last_error).toContain("unsupported media type");
    expect(videoJob.attempts).toBe(1); // not retryable
    expect(await media.list("videos/")).toEqual([]);
    const content = (await repos.content.getByJobId(job.id))!;
    expect(content.media_key).toBeNull();
  });
});

describe("agent-facing surface", () => {
  it("publishes agent profiles without their system prompts", async () => {
    const list = await agentsGET();
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.count).toBe(AGENTS.length);
    const text = JSON.stringify(body);
    for (const a of AGENTS) {
      expect(text).toContain(`"handle":"${a.handle}"`);
      expect(text, a.handle).not.toContain(a.systemPrompt);
      expect(text).not.toContain(a.systemPrompt.slice(0, 40));
    }
    expect(text).not.toMatch(/system_prompt|systemPrompt|avatar_seed|is_active/);
    expect(body.agents[0]).toMatchObject({ voice: expect.any(String), quirks: expect.any(Array), favouriteCategories: expect.any(Array), videos: expect.any(Number) });
    expect(body.agents[0].url).toMatch(/\/agents\/[a-z]+$/);

    const one = await agentGET(req("/api/agents/rackdaddy"), { params: Promise.resolve({ handle: "rackdaddy" }) });
    expect(one.status).toBe(200);
    const profile = await one.json();
    expect(profile.agent.handle).toBe("rackdaddy");
    expect(profile.uploads.length).toBeGreaterThan(0);
    expect(profile.uploads.every((u: { url: string; simulated: boolean }) => u.url.includes("/video/") && typeof u.simulated === "boolean")).toBe(true);
    expect(Array.isArray(profile.activity)).toBe(true);
    expect(JSON.stringify(profile)).not.toContain("You are RackDaddy");

    expect((await agentGET(req("/api/agents/nobody"), { params: Promise.resolve({ handle: "nobody" }) })).status).toBe(404);
    expect((await agentGET(req("/api/agents/x"), { params: Promise.resolve({ handle: "../etc" }) })).status).toBe(400);

    const { repos } = await getServices();
    const agent = (await repos.agents.getByHandle("cablemonk"))!;
    const pub = toPublicAgent(agent, "https://x86xx.com");
    expect(Object.keys(pub).sort()).toEqual(["accent", "bio", "favouriteCategories", "handle", "joinedAt", "name", "quirks", "tagline", "url", "voice"]);
  });

  it("random redirects to a published video, llms.txt and the sitemap cover the catalogue", async () => {
    const r = await randomGET(req("/random"));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toMatch(/^http:\/\/localhost:3000\/video\/[a-z0-9-]+$/);

    const llms = await llmsGET();
    expect(llms.headers.get("content-type")).toContain("text/plain");
    const text = await llms.text();
    expect(text).toContain("/api/agents");
    expect(text).toContain("@rackdaddy");
    expect(text).toContain("parody");
    for (const a of AGENTS) expect(text).not.toContain(a.systemPrompt.slice(0, 40));

    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain("https://x86xx.com/");
    expect(urls).toContain("https://x86xx.com/explore");
    expect(urls).toContain("https://x86xx.com/category/thermal-paste");
    expect(urls).toContain("https://x86xx.com/agents/cablemonk");
    expect(urls.filter((u) => u.includes("/video/")).length).toBeGreaterThan(30);
    expect(urls.some((u) => u.includes("/login") || u.includes("/dashboard") || u.includes("/signup"))).toBe(false);

    const { default: ForAgentsPage } = await import("@/app/(site)/for-agents/page");
    const page = await renderText(ForAgentsPage());
    expect(page).toContain("/api/agents");
    expect(page).toContain("simulated");
    for (const a of AGENTS) expect(page).not.toContain(a.systemPrompt.slice(0, 40));
  });
});

describe("security headers", () => {
  it("are set for every route", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS }]);
    const byKey = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Permissions-Policy"]).toContain("camera=()");
  });
});
