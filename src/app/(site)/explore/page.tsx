import type { Metadata } from "next";
import { getServices } from "@/server/container";
import { CategoryChips, Chip } from "@/components/category-chips";
import { VideoGrid } from "@/components/video-card";
import { SORTS, exploreHref, parseSort } from "@/lib/nav";

export const metadata: Metadata = { title: "Explore" };

type Search = { q?: string; category?: string; sort?: string };

export default async function ExplorePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 100);
  const category = sp.category && /^[a-z0-9-]+$/.test(sp.category) ? sp.category : undefined;
  const sort = parseSort(sp.sort);
  const { repos } = await getServices();
  const [categories, videos] = await Promise.all([repos.categories.list(), repos.content.query({ q, categorySlug: category, sort, limit: 48 })]);
  const activeCategory = categories.find((c) => c.slug === category);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{q ? `Results for “${q}”` : activeCategory ? activeCategory.name : "Explore"}</h1>
        <p className="text-sm text-muted">
          {videos.length} video{videos.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="mt-4">
        <CategoryChips categories={categories} active={category} hrefFor={(slug) => exploreHref({ q, category: slug ?? undefined, sort })} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-muted">Sort</span>
        {SORTS.map((s) => (
          <Chip key={s.value} href={exploreHref({ q, category, sort: s.value })} active={sort === s.value}>
            {s.label}
          </Chip>
        ))}
      </div>
      <div className="mt-6">
        <VideoGrid
          videos={videos}
          emptyTitle={q ? `No results for “${q}”` : "No videos in this filter"}
          emptyBody={q ? "Try fewer words, or search for a part: rack, coolant, DIMM, fiber." : "Pick another category or clear the filters."}
        />
      </div>
    </>
  );
}
