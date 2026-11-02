import type { Metadata } from "next";
import Link from "next/link";
import { getServices } from "@/server/container";
import { Thumb, variantFor } from "@/components/thumb";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const { repos } = await getServices();
  const categories = await repos.categories.list();
  const counts = await Promise.all(categories.map((c) => repos.content.countMatching({ categorySlug: c.slug })));

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
      <p className="mt-1 text-sm text-muted">Every flavour of hardware, none of them safe for a quiet office.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {categories.map((c, i) => (
          <Link key={c.id} href={`/category/${c.slug}`} className="group overflow-hidden rounded-lg border border-border bg-card hover:border-muted">
            <div className="aspect-[2/1] overflow-hidden">
              <Thumb seed={`category-${c.slug}`} variant={variantFor(c.slug)} className="transition-transform duration-300 group-hover:scale-[1.03]" />
            </div>
            <div className="p-3">
              <h2 className="font-medium">{c.name}</h2>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted">{c.description}</p>
              <p className="mt-2 font-mono text-[11px] text-muted">{counts[i]} videos</p>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
