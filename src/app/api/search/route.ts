import type { NextRequest } from "next/server";
import { getServices } from "@/server/container";
import { parseSort } from "@/lib/nav";
import { error, json } from "@/server/http";

/** GET /api/search?q=&category=&sort=trending|newest|views&limit= */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (q.length > 100) return error(400, "q must be 100 characters or fewer", { field: "q" });
  const category = sp.get("category") ?? undefined;
  if (category && !/^[a-z0-9-]+$/.test(category)) return error(400, "category must be a slug", { field: "category" });
  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 24;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(400, "limit must be an integer 1-100", { field: "limit" });

  const { repos } = await getServices();
  const results = await repos.content.query({ q, categorySlug: category, sort: parseSort(sp.get("sort") ?? undefined), limit });
  return json({ query: { q, category: category ?? null, sort: parseSort(sp.get("sort") ?? undefined), limit }, count: results.length, results });
}
