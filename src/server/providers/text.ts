import type { ProviderName } from "../db/types";

export interface TextGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Ask for a JSON object response where the provider supports it. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface TextGenerationResult {
  text: string;
  provider: ProviderName;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Best-effort USD estimate. Mock providers report 0. */
  estimatedCostUsd: number;
  /** True when produced by a mock, so callers can label it as simulated. */
  simulated: boolean;
}

export interface TextProvider {
  readonly name: ProviderName;
  generate(req: TextGenerationRequest): Promise<TextGenerationResult>;
}

/** Shape the text job expects back from the model. */
export interface GeneratedListing {
  title: string;
  description: string;
  tags: string[];
}

export function parseListing(text: string): GeneratedListing {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("model response contained no JSON object");
  const obj = JSON.parse(text.slice(start, end + 1)) as Partial<GeneratedListing>;
  if (typeof obj.title !== "string" || obj.title.trim().length < 4) throw new Error("listing.title missing");
  if (typeof obj.description !== "string" || obj.description.trim().length < 10)
    throw new Error("listing.description missing");
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : [];
  return { title: obj.title.trim().slice(0, 120), description: obj.description.trim().slice(0, 600), tags: tags.slice(0, 8) };
}
