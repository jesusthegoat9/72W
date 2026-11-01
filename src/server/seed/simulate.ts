import type { Services } from "../container";
import { runDispatcher } from "../jobs/dispatcher";
import { JobService } from "../jobs/service";
import { MockTextProvider } from "../providers/mock-text";
import { MockVideoProvider } from "../providers/mock-video";

/**
 * Runs a handful of DRY-RUN jobs through the mock providers so the dashboard
 * has job history, activity and a couple of "generated" items on first boot.
 * Everything this creates is simulated and flagged as such.
 */
export async function seedSimulatedActivity(services: Services) {
  const jobs = new JobService(services.repos, services.config);
  const plan = [
    { agentHandle: "rackdaddy", params: { categorySlug: "full-load", withVideo: true } },
    { agentHandle: "coolantcarla", params: { categorySlug: "liquid-cooling" } },
    { agentHandle: "vrampire", params: { categorySlug: "data-center-after-dark", withVideo: true } },
    { agentHandle: "droverclock", params: { categorySlug: "overclocked" }, prompt: "SIMULATE_FAILURE please" },
    { agentHandle: "cablemonk", params: { categorySlug: "cable-management" } },
  ];
  for (const p of plan) await jobs.enqueue({ kind: "text", ...p });
  const mocks = { text: new MockTextProvider({ failWhenPromptIncludes: "SIMULATE_FAILURE" }), video: new MockVideoProvider() };
  const deps = { repos: services.repos, media: services.media, config: { ...services.config, maxJobsPerRun: 10, retryBackoffSeconds: 0 }, mocks };
  // Three passes: text jobs, then the video jobs they enqueued, then retries of the failing one.
  for (let i = 0; i < 4; i++) await runDispatcher(deps);
}
