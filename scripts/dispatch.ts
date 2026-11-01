/**
 * Runs the job dispatcher against the local database.
 *   npm run jobs:run            one pass
 *   npm run jobs:run -- --loop  keep running every 5s until nothing is left
 */
import { getServices } from "../src/server/container";
import { runDispatcher } from "../src/server/jobs/dispatcher";

async function main() {
  const loop = process.argv.includes("--loop");
  const s = await getServices();
  const deps = { repos: s.repos, media: s.media, config: s.config, log: (m: string) => console.log(m) };
  do {
    const r = await runDispatcher(deps);
    console.log(JSON.stringify(r));
    if (!loop || (r.claimed === 0 && r.pending === 0)) break;
    await new Promise((res) => setTimeout(res, 5000));
  } while (true);
  console.log("live generation:", s.config.liveGenerationEnabled ? "ENABLED" : "disabled (mock providers only)");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
