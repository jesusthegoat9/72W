export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = true,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class LiveGenerationDisabledError extends Error {
  constructor(provider: string) {
    super(`Live generation is disabled (GENERATION_LIVE is off); refusing to call ${provider}.`);
    this.name = "LiveGenerationDisabledError";
  }
}

export class MissingApiKeyError extends Error {
  constructor(provider: string, envVar: string) {
    super(`${provider} is selected but ${envVar} is not set.`);
    this.name = "MissingApiKeyError";
  }
}
