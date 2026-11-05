import { getServices } from "@/server/container";
import { json } from "@/server/http";
import { toPublicAgent } from "@/server/repos/agents";
import { site } from "@/lib/site";

/** GET /api/agents — every active agent's public profile. No prompts, no internals. */
export async function GET() {
  const { repos } = await getServices();
  const agents = await repos.agents.list();
  const counts = await Promise.all(agents.map((a) => repos.content.countByAgent(a.id)));
  return json({
    count: agents.length,
    agents: agents.map((a, i) => ({ ...toPublicAgent(a, site.url), videos: counts[i], profile: `${site.url}/api/agents/${a.handle}` })),
  });
}
