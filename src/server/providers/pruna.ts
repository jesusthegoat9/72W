import { ProviderError } from "./errors";
import type { VideoDownload, VideoGenerationRequest, VideoPollResult, VideoProvider, VideoSubmitResult } from "./video";

/**
 * Pruna P-Video adapter.
 * Docs: https://docs.api.pruna.ai/guides/models/p-video
 *
 * - POST {base}/v1/predictions with headers `apikey`, `Model: p-video`
 *   and body {"input": {...}} -> 201 {id, get_url}
 * - GET  {base}/v1/predictions/status/{id} -> {status, generation_url?, error?}
 *   status: starting | processing | succeeded | failed | canceled
 * - GET  generation_url with `apikey` -> video/mp4
 *
 * Defaults: 720p and draft=true (Pruna's own default is draft=false; we pin
 * the cheaper setting). Only constructed when GENERATION_LIVE is on and
 * PRUNA_API_KEY is set.
 */
export interface PrunaOptions {
  apiKey: string;
  model: string; // "p-video"
  pricePerSecondDraft: number;
  pricePerSecondStandard: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class PrunaVideoProvider implements VideoProvider {
  readonly name = "pruna" as const;
  readonly simulated = false;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: PrunaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? "https://api.pruna.ai").replace(/\/$/, "");
  }

  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.opts.apiKey, ...extra };
  }

  async submit(req: VideoGenerationRequest): Promise<VideoSubmitResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/predictions`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Model: this.opts.model }),
      body: JSON.stringify({
        input: {
          prompt: req.prompt,
          duration: Math.min(Math.max(Math.round(req.durationSeconds), 1), 20),
          resolution: req.resolution,
          draft: req.draft,
          aspect_ratio: req.aspectRatio ?? "16:9",
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(`Pruna HTTP ${res.status}: ${body.slice(0, 200)}`, "pruna", res.status >= 500 || res.status === 429, res.status);
    }
    const data = (await res.json()) as { id?: string; status?: string; generation_url?: string };
    if (!data.id) throw new ProviderError("Pruna response had no prediction id", "pruna", false);
    return { providerRef: data.id };
  }

  async poll(providerRef: string): Promise<VideoPollResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/predictions/status/${encodeURIComponent(providerRef)}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new ProviderError(`Pruna status HTTP ${res.status}`, "pruna", res.status >= 500 || res.status === 429, res.status);
    const data = (await res.json()) as {
      status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
      generation_url?: string;
      message?: string;
      error?: string;
      metadata?: Record<string, unknown>;
    };
    switch (data.status) {
      case "starting":
      case "processing":
        return { state: "pending", message: data.message };
      case "succeeded": {
        if (!data.generation_url) return { state: "failed", error: "succeeded without generation_url", retryable: false };
        const url = data.generation_url.startsWith("/") ? `${this.baseUrl}${data.generation_url}` : data.generation_url;
        return { state: "succeeded", outputUrl: url, metadata: data.metadata };
      }
      case "canceled":
        return { state: "canceled" };
      default:
        return { state: "failed", error: data.error ?? data.message ?? "unknown failure", retryable: false };
    }
  }

  async download(outputUrl: string): Promise<VideoDownload> {
    const res = await this.fetchImpl(outputUrl, { headers: this.headers() });
    if (!res.ok) throw new ProviderError(`Pruna download HTTP ${res.status}`, "pruna", res.status >= 500, res.status);
    const contentType = res.headers.get("content-type") ?? "video/mp4";
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType, extension: contentType.includes("mp4") ? "mp4" : "bin" };
  }

  estimateCostUsd(req: VideoGenerationRequest): number {
    const perSecond = req.draft ? this.opts.pricePerSecondDraft : this.opts.pricePerSecondStandard;
    const factor = req.resolution === "1080p" ? 2 : 1; // Pruna lists 1080p at 2x the 720p rate
    return req.durationSeconds * perSecond * factor;
  }
}
