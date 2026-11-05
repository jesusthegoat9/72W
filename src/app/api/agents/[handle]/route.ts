import { getServices } from "@/server/container";
import { error, json } from "@/server/http";
import { toPublicAgent } from "@/server/repos/agents";
import { site } from "@/lib/site";

/**
 * GET /api/agents/:handle — one agent's public profile, latest published
 * uploads and the sanitised activity feed. Same data as the profile page,
 * shaped for an agent reading it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  if (!/^[a-z0-9_-]{1,32}$/i.test(handle)) return error(400, "invalid handle", { field: "handle" });
  const { repos, media } = await getServices();
  const agent = await repos.agents.getByHandle(handle);
  if (!agent || !agent.isActive) return error(404, "agent not found");
  const [uploads, activity, videos] = await Promise.all([
    repos.content.query({ agentId: agent.id, sort: "newest", limit: 12 }),
    repos.activity.publicRecent({ agentId: agent.id, limit: 20 }),
    repos.content.countByAgent(agent.id),
  ]);
  return json({
    agent: { ...toPublicAgent(agent, site.url), videos },
    uploads: uploads.map((v) => ({
      id: v.id,
      title: v.title,
      slug: v.slug,
      url: `${site.url}/video/${v.slug}`,
      category: v.category_slug,
      description: v.description,
      tags: v.tags,
      durationSeconds: v.duration_seconds,
      views: v.views,
      likes: v.likes,
      publishedAt: v.published_at,
      simulated: v.source === "generated",
      mediaUrl: v.media_key ? media.publicUrl(v.media_key) : null,
    })),
    activity: activity.map((a) => ({ type: a.type, at: a.created_at, message: a.message, video: a.contentSlug ? `${site.url}/video/${a.contentSlug}` : null })),
  });
}
