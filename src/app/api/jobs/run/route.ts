import type { NextRequest } from "next/server";
import { getServices } from "@/server/container";
import { runDispatcher } from "@/server/jobs/dispatcher";
import { error, json, tokenMatches } from "@/server/http";

/**
 * POST /api/jobs/run  (requires `Authorization: Bearer <JOBS_API_TOKEN>`)
 * Runs one dispatcher pass. Disabled (503) when JOBS_API_TOKEN is unset.
 * This is the hook a Cloudflare cron or an operator can call; it never runs
 * on its own, and live providers stay behind GENERATION_LIVE.
 */
export async function POST(req: NextRequest) {
  const { repos, media, config } = await getServices();
  if (!config.jobsApiToken) return error(503, "dispatcher endpoint is disabled: JOBS_API_TOKEN is not configured");
  const auth = req.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!tokenMatches(provided, config.jobsApiToken)) return error(401, "invalid or missing bearer token");
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return error(400, "limit must be a positive integer", { field: "limit" });
  const summary = await runDispatcher({ repos, media, config }, { limit });
  return json({ summary, liveGeneration: config.liveGenerationEnabled });
}
