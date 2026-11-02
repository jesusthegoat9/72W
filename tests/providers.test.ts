import { describe, expect, it, vi } from "vitest";
import { selectProviders } from "@/server/providers";
import { LiveGenerationDisabledError, MissingApiKeyError } from "@/server/providers/errors";
import { PrunaVideoProvider } from "@/server/providers/pruna";
import { OpenRouterTextProvider } from "@/server/providers/openrouter";
import { parseListing } from "@/server/providers/text";
import { MOCK_SUBJECT_CATEGORIES, MockTextProvider } from "@/server/providers/mock-text";
import { CATEGORIES } from "@/server/seed/data";
import { testConfig } from "./helpers";

function fakeFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? { body: {} };
    const isBinary = r.body instanceof Uint8Array;
    return new Response((isBinary ? r.body : JSON.stringify(r.body)) as BodyInit, {
      status: r.status ?? 200,
      headers: { "content-type": isBinary ? "video/mp4" : "application/json", ...(r.headers ?? {}) },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("provider selection", () => {
  it("dry runs always get mocks", () => {
    const p = selectProviders(testConfig({ liveGenerationEnabled: true }), true);
    expect(p.text.name).toBe("mock");
    expect(p.video.name).toBe("mock");
  });
  it("live is refused when the switch is off, even with keys", () => {
    const cfg = testConfig({ liveGenerationEnabled: false });
    cfg.openrouter.apiKey = "k";
    cfg.pruna.apiKey = "k";
    expect(() => selectProviders(cfg, false)).toThrow(LiveGenerationDisabledError);
  });
  it("live requires both API keys", () => {
    const cfg = testConfig({ liveGenerationEnabled: true });
    expect(() => selectProviders(cfg, false)).toThrow(MissingApiKeyError);
    cfg.openrouter.apiKey = "k";
    expect(() => selectProviders(cfg, false)).toThrow(/PRUNA_API_KEY/);
    cfg.pruna.apiKey = "k";
    const p = selectProviders(cfg, false);
    expect(p.text.name).toBe("openrouter");
    expect(p.video.name).toBe("pruna");
  });
});

describe("Pruna adapter", () => {
  it("submits 720p draft requests with the documented headers and body", async () => {
    const f = fakeFetch([{ status: 201, body: { id: "pred_1", get_url: "https://api.pruna.ai/v1/predictions/status/pred_1" } }]);
    const p = new PrunaVideoProvider({ apiKey: "secret", model: "p-video", pricePerSecondDraft: 0.005, pricePerSecondStandard: 0.02, fetchImpl: f.fetch });
    const req = { prompt: "a rack", durationSeconds: 5, resolution: "720p" as const, draft: true };
    expect(await p.submit(req)).toEqual({ providerRef: "pred_1" });
    const call = f.calls[0];
    expect(call.url).toBe("https://api.pruna.ai/v1/predictions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.apikey).toBe("secret");
    expect(headers.Model).toBe("p-video");
    expect(JSON.parse(call.init.body as string)).toEqual({ input: { prompt: "a rack", duration: 5, resolution: "720p", draft: true, aspect_ratio: "16:9" } });
    expect(p.estimateCostUsd(req)).toBeCloseTo(0.025);
    expect(p.estimateCostUsd({ ...req, draft: false })).toBeCloseTo(0.1);
  });

  it("maps poll statuses and resolves relative delivery urls", async () => {
    const f = fakeFetch([
      { body: { status: "processing", message: "Generation in progress" } },
      { body: { status: "succeeded", generation_url: "/v1/predictions/delivery/x/output.mp4", metadata: { seed: 42 } } },
      { body: { status: "failed", error: "bad input" } },
      { body: { status: "canceled" } },
    ]);
    const p = new PrunaVideoProvider({ apiKey: "k", model: "p-video", pricePerSecondDraft: 0.005, pricePerSecondStandard: 0.02, fetchImpl: f.fetch });
    expect(await p.poll("pred_1")).toMatchObject({ state: "pending" });
    expect(await p.poll("pred_1")).toEqual({ state: "succeeded", outputUrl: "https://api.pruna.ai/v1/predictions/delivery/x/output.mp4", metadata: { seed: 42 } });
    expect(await p.poll("pred_1")).toMatchObject({ state: "failed", error: "bad input", retryable: false });
    expect(await p.poll("pred_1")).toEqual({ state: "canceled" });
    expect(f.calls[0].url).toBe("https://api.pruna.ai/v1/predictions/status/pred_1");
  });

  it("only sends the API key to the Pruna origin and never follows redirects", async () => {
    const f = fakeFetch([
      { body: new Uint8Array([0, 1, 2]) },
      { status: 302, body: {}, headers: { location: "https://evil.example/steal" } },
    ]);
    const p = new PrunaVideoProvider({ apiKey: "secret", model: "p-video", pricePerSecondDraft: 0.005, pricePerSecondStandard: 0.02, fetchImpl: f.fetch });

    await expect(p.download("https://evil.example/v1/predictions/delivery/x/output.mp4")).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/refusing to send Pruna credentials to https:\/\/evil.example/) });
    await expect(p.download("http://api.pruna.ai/v1/predictions/delivery/x/output.mp4")).rejects.toThrow(/refusing/);
    await expect(p.download("https://api.pruna.ai.evil.example/x")).rejects.toThrow(/refusing/);
    await expect(p.download("not a url")).rejects.toThrow(/not a valid URL/);
    expect(f.calls.length).toBe(0);

    const ok = await p.download("https://api.pruna.ai/v1/predictions/delivery/x/output.mp4");
    expect(ok.contentType).toBe("video/mp4");
    expect((f.calls[0].init.headers as Record<string, string>).apikey).toBe("secret");
    expect(f.calls[0].init.redirect).toBe("manual");

    await expect(p.download("https://api.pruna.ai/v1/predictions/delivery/y/output.mp4")).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/redirected \(302\)/) });
    expect(f.calls.length).toBe(2);
  });

  it("marks 5xx/429 as retryable and 4xx as not", async () => {
    const f = fakeFetch([{ status: 429, body: { error: "slow down" } }, { status: 400, body: { error: "nope" } }]);
    const p = new PrunaVideoProvider({ apiKey: "k", model: "p-video", pricePerSecondDraft: 0.005, pricePerSecondStandard: 0.02, fetchImpl: f.fetch });
    const req = { prompt: "x", durationSeconds: 5, resolution: "720p" as const, draft: true };
    await expect(p.submit(req)).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(p.submit(req)).rejects.toMatchObject({ retryable: false, status: 400 });
  });
});

describe("OpenRouter adapter", () => {
  it("sends an OpenAI-compatible request and reports usage and cost", async () => {
    const f = fakeFetch([{ body: { id: "gen-1", model: "qwen/qwen3.7-flash", choices: [{ message: { content: '{"title":"T","description":"D","tags":[]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0000095 } } }]);
    const p = new OpenRouterTextProvider({ apiKey: "sk", model: "qwen/qwen3.7-flash", inputPricePerM: 0.03, outputPricePerM: 0.13, siteUrl: "https://x86xx.com", appTitle: "x86xx", fetchImpl: f.fetch });
    const r = await p.generate({ systemPrompt: "sys", userPrompt: "user", json: true });
    expect(r).toMatchObject({ provider: "openrouter", model: "qwen/qwen3.7-flash", usage: { inputTokens: 100, outputTokens: 50 }, estimatedCostUsd: 0.0000095, simulated: false });
    const call = f.calls[0];
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk");
    expect(headers["HTTP-Referer"]).toBe("https://x86xx.com");
    expect(headers["X-OpenRouter-Title"]).toBe("x86xx");
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe("qwen/qwen3.7-flash");
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "user" }]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("estimates cost from configured prices when the API omits it", async () => {
    const f = fakeFetch([{ body: { id: "g", model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } } }]);
    const p = new OpenRouterTextProvider({ apiKey: "sk", model: "m", inputPricePerM: 0.03, outputPricePerM: 0.13, fetchImpl: f.fetch });
    expect((await p.generate({ systemPrompt: "s", userPrompt: "u" })).estimatedCostUsd).toBeCloseTo(0.16);
  });
});

describe("parseListing", () => {
  it("extracts a JSON object even with surrounding prose and validates it", () => {
    expect(parseListing('Sure! {"title":"Hot Rack Hour","description":"forty minutes of fans","tags":["racks",1]} done')).toEqual({ title: "Hot Rack Hour", description: "forty minutes of fans", tags: ["racks"] });
    expect(() => parseListing("no json here")).toThrow(/no JSON/);
    expect(() => parseListing('{"title":"x"}')).toThrow(/title/);
  });
});

describe("mock text provider", () => {
  it("has on-topic subjects for every seeded category and tags the listing with it", async () => {
    for (const c of CATEGORIES) expect(MOCK_SUBJECT_CATEGORIES, c.slug).toContain(c.slug);
    const provider = new MockTextProvider();
    for (const c of CATEGORIES) {
      const res = await provider.generate({ systemPrompt: "voice: zen, minimal", userPrompt: `Create a new listing.\ncategory: ${c.slug}` });
      const listing = parseListing(res.text);
      expect(listing.tags, c.slug).toContain(c.slug);
      expect(listing.title.length, c.slug).toBeGreaterThan(8);
      // A thermal-paste job must not come back as a hot-racks subject.
      if (c.slug === "thermal-paste") expect(listing.title.toLowerCase()).toMatch(/paste|dot|reapply/);
      if (c.slug === "clean-builds") expect(listing.title.toLowerCase()).toMatch(/build|fan|glass/);
    }
    // Deterministic for the same prompt, different across categories.
    const a = await provider.generate({ systemPrompt: "voice: zen", userPrompt: "category: hot-swaps" });
    const b = await provider.generate({ systemPrompt: "voice: zen", userPrompt: "category: hot-swaps" });
    expect(a.text).toBe(b.text);
    expect(res(a.text).title).not.toBe((await provider.generate({ systemPrompt: "voice: zen", userPrompt: "category: unlimited-context" })).text);
    function res(t: string) {
      return parseListing(t);
    }
  });
});
