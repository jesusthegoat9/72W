import { slugify } from "../db/ids";
import type { Repos } from "../repos";
import { AGENTS, CATEGORIES, VIDEOS } from "./data";

export interface SeedResult {
  /** True when the catalogue was empty and agents were created (first boot). */
  seeded: boolean;
  categories: number;
  agents: number;
  videos: number;
}

/**
 * Seeds the base catalogue additively: categories missing by slug, agents
 * missing by handle and videos missing by slug are inserted; everything
 * already present is left alone. Safe to run on every boot against an
 * existing database. All of this is simulated content.
 */
export async function seedCatalogue(repos: Repos, opts: { now?: Date } = {}): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const firstBoot = (await repos.agents.count()) === 0;
  const result: SeedResult = { seeded: firstBoot, categories: 0, agents: 0, videos: 0 };

  const categories = new Map<string, string>();
  for (const c of CATEGORIES) {
    const existing = await repos.categories.getBySlug(c.slug);
    if (existing) {
      categories.set(c.slug, existing.id);
      continue;
    }
    categories.set(c.slug, (await repos.categories.insert(c)).id);
    result.categories++;
  }

  const agents = new Map<string, string>();
  for (const a of AGENTS) {
    const existing = await repos.agents.getByHandle(a.handle);
    if (existing) {
      agents.set(a.handle, existing.id);
      continue;
    }
    agents.set(a.handle, (await repos.agents.insert(a)).id);
    result.agents++;
  }

  for (const v of VIDEOS) {
    if (await repos.content.getCard(slugify(v.title))) continue;
    const agentId = agents.get(v.agent);
    const categoryId = categories.get(v.category);
    if (!agentId || !categoryId) throw new Error(`seed: unknown agent/category for "${v.title}"`);
    const publishedAt = new Date(now.getTime() - v.daysAgo * 86_400_000).toISOString();
    const content = await repos.content.insert({
      agentId,
      categoryId,
      title: v.title,
      description: v.description,
      tags: v.tags,
      durationSeconds: v.duration,
      views: v.views,
      likes: v.likes,
      status: "published",
      source: "seed",
      publishedAt,
      createdAt: publishedAt,
    });
    await repos.activity.log({
      type: "content.published",
      message: `Published "${v.title}"`,
      agentId,
      contentId: content.id,
      simulated: true,
      createdAt: publishedAt,
    });
    result.videos++;
  }
  return result;
}
