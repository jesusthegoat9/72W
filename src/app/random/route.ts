import { NextResponse } from "next/server";
import { getServices } from "@/server/container";

/**
 * GET /random → a random published video. The "I'm feeling lucky" button.
 * Not cached: every hit picks again.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { repos } = await getServices();
  const pick = await repos.content.random();
  const target = pick ? `/video/${pick.slug}` : "/explore";
  return NextResponse.redirect(new URL(target, req.url), 307);
}
