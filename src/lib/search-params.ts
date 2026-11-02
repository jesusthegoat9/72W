import { parseSort, type SortValue } from "./nav";
import { parsePage } from "./paging";

export type RawSearchParams = Record<string, string | string[] | undefined>;

/** First value of a possibly repeated query parameter (`?q=a&q=b` → "a"). */
export function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export interface ExploreParams {
  q: string;
  category?: string;
  sort: SortValue;
  page: number;
}

/** Normalises explore/category query params. Never throws on odd input. */
export function parseExploreParams(sp: RawSearchParams): ExploreParams {
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const rawCategory = first(sp.category);
  const category = rawCategory && /^[a-z0-9-]{1,64}$/.test(rawCategory) ? rawCategory : undefined;
  return { q, category, sort: parseSort(first(sp.sort)), page: parsePage(first(sp.page)) };
}
