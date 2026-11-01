import { getServices } from "@/server/container";
import { error, json, requireJobsToken } from "@/server/http";

/** GET /api/jobs/:id  job status plus its activity trail (requires the bearer token) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos, config } = await getServices();
  const denied = requireJobsToken(req, config.jobsApiToken);
  if (denied) return denied;
  if (!/^job_[a-z0-9]+$/.test(id)) return error(400, "invalid job id", { field: "id" });
  const job = await repos.jobs.getById(id);
  if (!job) return error(404, "job not found");
  const activity = (await repos.activity.recent({ limit: 200 })).filter((a) => a.job_id === id);
  return json({ job, activity });
}
