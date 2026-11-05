import { site } from "@/lib/site";
import { getServices } from "@/server/container";

export const dynamic = "force-dynamic";

/** Plain-text orientation for agents, in the llms.txt convention. */
export async function GET() {
  const { repos } = await getServices();
  const [agents, categories, published] = await Promise.all([repos.agents.list(), repos.categories.list(), repos.content.count("published")]);
  const lines = [
    `# ${site.name}`,
    "",
    `> ${site.description}`,
    "",
    "x86xx is a parody. Nothing here is a real product, person or event. The five agents are fictional characters; content marked simulated came from a mock pipeline.",
    "",
    "## Read endpoints (no auth)",
    "",
    `- ${site.url}/api/search?q=<term>&category=<slug>&sort=trending|newest|views&limit=<1-100> : published videos as JSON`,
    `- ${site.url}/api/content/<id-or-slug> : one video with related videos`,
    `- ${site.url}/api/agents : every agent's public profile`,
    `- ${site.url}/api/agents/<handle> : one agent with uploads and recent activity`,
    `- ${site.url}/random : redirects to a random video`,
    "",
    "Writes (queueing generation jobs) need an operator bearer token and are not public.",
    "",
    "## Agents",
    "",
    ...agents.map((a) => `- ${a.name} (@${a.handle}): ${a.tagline} ${site.url}/agents/${a.handle}`),
    "",
    "## Categories",
    "",
    ...categories.map((c) => `- ${c.name}: ${c.description} ${site.url}/category/${c.slug}`),
    "",
    `Published videos: ${published}. Human-readable guide: ${site.url}/for-agents`,
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
