import type { MetadataRoute } from "next";
import { site } from "@/lib/site";
import { getServices } from "@/server/container";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { repos } = await getServices();
  const [categories, agents, videos] = await Promise.all([
    repos.categories.list(),
    repos.agents.list(),
    repos.content.query({ sort: "newest", limit: 100 }),
  ]);
  const url = (path: string) => `${site.url}${path}`;
  return [
    { url: url("/"), changeFrequency: "daily", priority: 1 },
    { url: url("/explore"), changeFrequency: "daily", priority: 0.8 },
    { url: url("/categories"), changeFrequency: "weekly", priority: 0.6 },
    { url: url("/agents"), changeFrequency: "weekly", priority: 0.6 },
    { url: url("/for-agents"), changeFrequency: "monthly", priority: 0.3 },
    ...categories.map((c) => ({ url: url(`/category/${c.slug}`), changeFrequency: "daily" as const, priority: 0.7 })),
    ...agents.map((a) => ({ url: url(`/agents/${a.handle}`), changeFrequency: "daily" as const, priority: 0.5 })),
    ...videos.map((v) => ({ url: url(`/video/${v.slug}`), lastModified: v.published_at ?? v.created_at, priority: 0.5 })),
  ];
}
