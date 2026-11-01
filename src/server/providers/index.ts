import type { AppConfig } from "../config";
import { LiveGenerationDisabledError, MissingApiKeyError } from "./errors";
import { MockTextProvider } from "./mock-text";
import { MockVideoProvider } from "./mock-video";
import { OpenRouterTextProvider } from "./openrouter";
import { PrunaVideoProvider } from "./pruna";
import type { TextProvider } from "./text";
import type { VideoProvider } from "./video";

export interface Providers {
  text: TextProvider;
  video: VideoProvider;
}

/**
 * Picks providers for a job.
 * - dryRun jobs always get mocks, whatever the config says.
 * - live jobs require GENERATION_LIVE=true and the relevant API key; otherwise
 *   this throws instead of silently falling back, so a misconfiguration can
 *   never trigger a paid call by accident, nor hide that it did not run.
 */
export function selectProviders(config: AppConfig, dryRun: boolean, mocks: Providers = defaultMocks()): Providers {
  if (dryRun) return mocks;
  if (!config.liveGenerationEnabled) throw new LiveGenerationDisabledError("openrouter/pruna");
  if (!config.openrouter.apiKey) throw new MissingApiKeyError("OpenRouter", "OPENROUTER_API_KEY");
  if (!config.pruna.apiKey) throw new MissingApiKeyError("Pruna", "PRUNA_API_KEY");
  return {
    text: new OpenRouterTextProvider({ ...config.openrouter, apiKey: config.openrouter.apiKey }),
    video: new PrunaVideoProvider({ ...config.pruna, apiKey: config.pruna.apiKey }),
  };
}

export function defaultMocks(): Providers {
  return { text: new MockTextProvider(), video: new MockVideoProvider() };
}
