import { ProviderError } from "./errors";
import type { TextGenerationRequest, TextGenerationResult, TextProvider } from "./text";

/**
 * OpenRouter chat completions adapter (OpenAI-compatible).
 * Docs: https://openrouter.ai/docs/api-reference/chat-completion
 *
 * Only constructed when GENERATION_LIVE is on and OPENROUTER_API_KEY is set.
 * Model and prices are configurable; defaults target a low-cost Qwen model.
 */
export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  siteUrl?: string;
  appTitle?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  id: string;
  model: string;
  choices: { message: { content: string | null }; finish_reason: string; error?: { message: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
}

export class OpenRouterTextProvider implements TextProvider {
  readonly name = "openrouter" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenRouterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  }

  async generate(req: TextGenerationRequest): Promise<TextGenerationResult> {
    const model = req.model ?? this.opts.model;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.opts.siteUrl) headers["HTTP-Referer"] = this.opts.siteUrl;
    if (this.opts.appTitle) headers["X-OpenRouter-Title"] = this.opts.appTitle;

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userPrompt },
        ],
        max_tokens: req.maxTokens ?? 400,
        temperature: req.temperature ?? 0.9,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`, "openrouter", res.status >= 500 || res.status === 429, res.status);
    }
    const data = (await res.json()) as ChatResponse;
    const choice = data.choices?.[0];
    if (!choice || choice.error) throw new ProviderError(choice?.error?.message ?? "empty response", "openrouter", false);
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const estimatedCostUsd =
      data.usage?.cost ?? (inputTokens * this.opts.inputPricePerM + outputTokens * this.opts.outputPricePerM) / 1_000_000;
    return {
      text: choice.message.content ?? "",
      provider: "openrouter",
      model: data.model ?? model,
      usage: { inputTokens, outputTokens },
      estimatedCostUsd,
      simulated: false,
    };
  }
}
