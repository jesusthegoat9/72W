import type { VideoDownload, VideoGenerationRequest, VideoPollResult, VideoProvider, VideoSubmitResult } from "./video";

/**
 * Mock video provider. "Renders" an SVG poster that says MOCK RENDER so the
 * pipeline (submit -> poll -> download -> store) runs end to end with no
 * network. `pendingPolls` simulates an async provider that is not done yet.
 */
export class MockVideoProvider implements VideoProvider {
  readonly name = "mock" as const;
  readonly simulated = true;
  private readonly polls = new Map<string, number>();
  private readonly prompts = new Map<string, VideoGenerationRequest>();

  constructor(private readonly opts: { pendingPolls?: number; failWhenPromptIncludes?: string } = {}) {}

  async submit(req: VideoGenerationRequest): Promise<VideoSubmitResult> {
    const ref = `mock_${Math.random().toString(36).slice(2, 10)}`;
    this.polls.set(ref, 0);
    this.prompts.set(ref, req);
    return { providerRef: ref };
  }

  async poll(providerRef: string): Promise<VideoPollResult> {
    const req = this.prompts.get(providerRef);
    if (!req) return { state: "failed", error: "unknown providerRef", retryable: false };
    const n = (this.polls.get(providerRef) ?? 0) + 1;
    this.polls.set(providerRef, n);
    if (this.opts.failWhenPromptIncludes && req.prompt.includes(this.opts.failWhenPromptIncludes)) {
      return { state: "failed", error: "mock video provider: simulated failure", retryable: true };
    }
    if (n <= (this.opts.pendingPolls ?? 0)) return { state: "pending", message: "rendering" };
    return { state: "succeeded", outputUrl: `mock://${providerRef}`, metadata: { seed: req.seed ?? 0 } };
  }

  async download(outputUrl: string): Promise<VideoDownload> {
    const ref = outputUrl.replace("mock://", "");
    const req = this.prompts.get(ref);
    const label = (req?.prompt ?? "").slice(0, 60).replace(/[<>&]/g, "");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101418"/><stop offset="1" stop-color="#1e2a33"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/>
${Array.from({ length: 12 }, (_, i) => `<rect x="120" y="${80 + i * 46}" width="1040" height="34" rx="4" fill="#0b0f12" stroke="#2c3b47"/><circle cx="150" cy="${97 + i * 46}" r="5" fill="${i % 3 ? "#39d98a" : "#ffb347"}"/>`).join("")}
<text x="640" y="660" text-anchor="middle" font-family="monospace" font-size="40" fill="#9fb3c8">MOCK RENDER · ${req?.resolution ?? "720p"} · draft=${req?.draft ?? true}</text>
<text x="640" y="700" text-anchor="middle" font-family="monospace" font-size="22" fill="#5f7384">${label}</text>
</svg>`;
    return { bytes: new TextEncoder().encode(svg), contentType: "image/svg+xml", extension: "svg" };
  }

  estimateCostUsd(): number {
    return 0;
  }
}
