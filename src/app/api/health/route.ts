import { getServices } from "@/server/container";
import { json } from "@/server/http";

export async function GET() {
  const { config, repos } = await getServices();
  const jobs = await repos.jobs.counts();
  return json({ ok: true, backend: config.dataBackend, liveGeneration: config.liveGenerationEnabled, jobs });
}
