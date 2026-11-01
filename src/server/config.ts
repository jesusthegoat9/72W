/**
 * Runtime configuration, all from environment variables with safe defaults.
 * Nothing here enables paid generation unless explicitly switched on.
 */

export type DataBackend = "sqlite" | "cloudflare";

export interface AppConfig {
  dataBackend: DataBackend;
  sqlitePath: string;
  mediaRoot: string;
  /** Master switch for calling real providers. Default OFF. */
  liveGenerationEnabled: boolean;
  /** When true (default) jobs run against mock providers and are marked dry_run. */
  dryRunDefault: boolean;
  maxJobsPerRun: number;
  maxLiveJobsPerDay: number;
  maxAttempts: number;
  retryBackoffSeconds: number;
  /** A job left in `processing` this long with no provider reference is assumed orphaned and requeued. */
  staleAfterSeconds: number;
  /** Token required for the write endpoints under /api/jobs. Unset = endpoints disabled. */
  jobsApiToken: string | null;
  openrouter: {
    apiKey: string | null;
    model: string;
    /** USD per 1M tokens, for cost estimates only. */
    inputPricePerM: number;
    outputPricePerM: number;
    siteUrl: string;
    appTitle: string;
  };
  pruna: {
    apiKey: string | null;
    model: string;
    resolution: "720p" | "1080p";
    draft: boolean;
    durationSeconds: number;
    /** USD per second of returned video, for cost estimates only. */
    pricePerSecondDraft: number;
    pricePerSecondStandard: number;
  };
}

const bool = (v: string | undefined, dflt: boolean) =>
  v === undefined || v === "" ? dflt : ["1", "true", "yes", "on"].includes(v.toLowerCase());
const num = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return v === undefined || v === "" || Number.isNaN(n) ? dflt : n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const resolution = env.PRUNA_RESOLUTION === "1080p" ? "1080p" : "720p";
  return {
    dataBackend: env.DATA_BACKEND === "cloudflare" ? "cloudflare" : "sqlite",
    sqlitePath: env.SQLITE_PATH ?? ".data/x86xx.db",
    mediaRoot: env.MEDIA_ROOT ?? ".data/media",
    liveGenerationEnabled: bool(env.GENERATION_LIVE, false),
    dryRunDefault: bool(env.GENERATION_DRY_RUN, true),
    maxJobsPerRun: num(env.GENERATION_MAX_PER_RUN, 5),
    maxLiveJobsPerDay: num(env.GENERATION_MAX_LIVE_PER_DAY, 10),
    maxAttempts: num(env.GENERATION_MAX_ATTEMPTS, 3),
    retryBackoffSeconds: num(env.GENERATION_RETRY_BACKOFF_SECONDS, 60),
    staleAfterSeconds: num(env.GENERATION_STALE_AFTER_SECONDS, 900),
    jobsApiToken: env.JOBS_API_TOKEN || null,
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY || null,
      model: env.OPENROUTER_MODEL ?? "qwen/qwen3.7-flash",
      inputPricePerM: num(env.OPENROUTER_INPUT_PRICE_PER_M, 0.03),
      outputPricePerM: num(env.OPENROUTER_OUTPUT_PRICE_PER_M, 0.13),
      siteUrl: env.NEXT_PUBLIC_SITE_URL ?? "https://x86xx.com",
      appTitle: "x86xx",
    },
    pruna: {
      apiKey: env.PRUNA_API_KEY || null,
      model: env.PRUNA_MODEL ?? "p-video",
      resolution,
      draft: bool(env.PRUNA_DRAFT, true),
      durationSeconds: num(env.PRUNA_DURATION_SECONDS, 5),
      pricePerSecondDraft: num(env.PRUNA_PRICE_PER_SECOND_DRAFT, 0.005),
      pricePerSecondStandard: num(env.PRUNA_PRICE_PER_SECOND_STANDARD, 0.02),
    },
  };
}
