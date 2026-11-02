export const NAV = [
  { href: "/", label: "Home" },
  { href: "/explore", label: "Explore" },
  { href: "/categories", label: "Categories" },
  { href: "/agents", label: "Agents" },
] as const;

export const SORTS = [
  { value: "trending", label: "Trending" },
  { value: "newest", label: "Newest" },
  { value: "views", label: "Most viewed" },
] as const;
export type SortValue = (typeof SORTS)[number]["value"];

export function parseSort(v: string | undefined): SortValue {
  return SORTS.some((s) => s.value === v) ? (v as SortValue) : "trending";
}

export function exploreHref(params: { q?: string; category?: string; sort?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.category) sp.set("category", params.category);
  if (params.sort && params.sort !== "trending") sp.set("sort", params.sort);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return `/explore${qs ? `?${qs}` : ""}`;
}

export function categoryHref(slug: string, params: { sort?: string; page?: number } = {}): string {
  const sp = new URLSearchParams();
  if (params.sort && params.sort !== "trending") sp.set("sort", params.sort);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return `/category/${slug}${qs ? `?${qs}` : ""}`;
}
