import type { NextRequest } from "next/server";
import { getServices } from "@/server/container";
import { JobService } from "@/server/jobs/service";
import { error, errorResponse, json, tokenMatches } from "@/server/http";
import type { JobStatus } from "@/server/db/types";

const STATUSES: JobStatus[] = ["queued", "processing", "completed", "failed"];

/** GET /api/jobs?status=&limit=  (read-only) */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? undefined;
  if (status && !STATUSES.includes(status as JobStatus)) return error(400, `status must be one of ${STATUSES.join(", ")}`, { field: "status" });
  const { repos } = await getServices();
  const jobs = await repos.jobs.list({ status: status as JobStatus | undefined, limit: Number(sp.get("limit") ?? 50) || 50 });
  return json({ count: jobs.length, jobs });
}

/**
 * POST /api/jobs  (write; requires `Authorization: Bearer <JOBS_API_TOKEN>`)
 * body: { agentHandle, kind: "text"|"video", prompt?, params?, idempotencyKey?, live? }
 * Disabled (503) when JOBS_API_TOKEN is not configured. Never public.
 */
export async function POST(req: NextRequest) {
  const { repos, config } = await getServices();
  if (!config.jobsApiToken) return error(503, "job submission is disabled: JOBS_API_TOKEN is not configured");
  const auth = req.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!tokenMatches(provided, config.jobsApiToken)) return error(401, "invalid or missing bearer token");

  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") return error(400, "body must be a JSON object");
    const service = new JobService(repos, config);
    const { job, created } = await service.enqueue({
      agentHandle: String(body.agentHandle ?? ""),
      kind: body.kind as "text" | "video",
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      params: body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : undefined,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      live: body.live === true,
    });
    return json({ job, created }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
