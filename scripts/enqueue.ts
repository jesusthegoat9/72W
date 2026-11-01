/**
 * Enqueue a dry-run text job for an agent.
 *   npm run jobs:enqueue -- <agentHandle> [categorySlug] [--video] [--live] [--prompt "..."]
 * --live requests a real provider run; it is refused unless GENERATION_LIVE=true
 * and API keys are configured, and it counts against the daily live limit.
 */
import { getServices } from "../src/server/container";
import { JobService } from "../src/server/jobs/service";

async function main() {
  const args = process.argv.slice(2);
  const [agentHandle, categorySlug] = args.filter((a) => !a.startsWith("--"));
  if (!agentHandle) {
    console.error("usage: npm run jobs:enqueue -- <agentHandle> [categorySlug] [--video] [--live] [--prompt \"...\"]");
    process.exit(2);
  }
  const promptIdx = args.indexOf("--prompt");
  const s = await getServices();
  const svc = new JobService(s.repos, s.config);
  const { job, created } = await svc.enqueue({
    agentHandle,
    kind: "text",
    prompt: promptIdx >= 0 ? args[promptIdx + 1] : undefined,
    params: { ...(categorySlug && !categorySlug.startsWith("--") ? { categorySlug } : {}), withVideo: args.includes("--video") },
    live: args.includes("--live"),
  });
  console.log(`${created ? "queued" : "already exists"}: ${job.id} (${job.dryRun ? "dry run" : "LIVE"}) provider=${job.provider}`);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
