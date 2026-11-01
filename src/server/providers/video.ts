import type { ProviderName } from "../db/types";

export interface VideoGenerationRequest {
  prompt: string;
  durationSeconds: number;
  resolution: "720p" | "1080p";
  draft: boolean;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  seed?: number;
}

export interface VideoSubmitResult {
  providerRef: string;
}

export type VideoPollResult =
  | { state: "pending"; message?: string }
  | { state: "succeeded"; outputUrl: string; metadata?: Record<string, unknown> }
  | { state: "failed"; error: string; retryable: boolean }
  | { state: "canceled" };

export interface VideoDownload {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
}

export interface VideoProvider {
  readonly name: ProviderName;
  /** True when outputs are placeholders, so content can be labelled as simulated. */
  readonly simulated: boolean;
  submit(req: VideoGenerationRequest): Promise<VideoSubmitResult>;
  poll(providerRef: string): Promise<VideoPollResult>;
  download(outputUrl: string): Promise<VideoDownload>;
  /** Best-effort USD estimate for a request. */
  estimateCostUsd(req: VideoGenerationRequest): number;
}
