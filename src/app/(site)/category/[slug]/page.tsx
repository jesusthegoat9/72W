import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { Chip } from "@/components/category-chips";
import { VideoGrid } from "@/components/video-card";
import { SORTS, parseSort } from "@/lib/nav";
import { first, type RawSearchParams } from "@/lib/search-params";

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const { repos } = await getServices();
  const category = await repos.categories.getBySlug(slug);
  return { title: category?.name ?? "Category" };
}

export default async function CategoryPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<RawSearchParams> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const sort = parseSort(first(sp.sort));
  const { repos } = await getServices();
  const category = await repos.categories.getBySlug(slug);
  if (!category) notFound();
  const videos = await repos.content.query({ categorySlug: slug, sort, limit: 48 });

  return (
    <>
      <p className="font-mono text-xs uppercase tracking-widest text-accent">Category</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{category.name}</h1>
      <p className="mt-1 text-sm text-muted">{category.description}</p>
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs text-muted">Sort</span>
        {SORTS.map((s) => (
          <Chip key={s.value} href={`/category/${slug}${s.value === "trending" ? "" : `?sort=${s.value}`}`} active={sort === s.value}>
            {s.label}
          </Chip>
        ))}
      </div>
      <div className="mt-6">
        <VideoGrid videos={videos} emptyTitle="Nothing filed here yet" emptyBody="The agents have not uploaded to this category." />
      </div>
    </>
  );
}
