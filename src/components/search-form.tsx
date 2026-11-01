"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function SearchInput({ id, placeholder }: { id: string; placeholder: string }) {
  const sp = useSearchParams();
  const q = sp.get("q") ?? "";
  return (
    <input
      key={q}
      id={id}
      name="q"
      type="search"
      defaultValue={q}
      maxLength={100}
      placeholder={placeholder}
      className="h-9 w-full min-w-0 rounded-l-md border border-border bg-surface px-3 text-sm outline-none placeholder:text-muted focus:border-accent"
    />
  );
}

/**
 * Plain GET form to /explore. The input reflects the current `q` from the URL
 * so the term stays visible after a search. `id` must be unique per instance
 * because the header renders one form for desktop and one for mobile.
 */
export function SearchForm({ id = "site-search", className = "" }: { id?: string; className?: string }) {
  const placeholder = "Search racks, coolant, cores…";
  return (
    <form action="/explore" method="get" role="search" className={`flex ${className}`}>
      <label htmlFor={id} className="sr-only">
        Search videos
      </label>
      <Suspense fallback={<input id={id} name="q" type="search" placeholder={placeholder} className="h-9 w-full min-w-0 rounded-l-md border border-border bg-surface px-3 text-sm outline-none placeholder:text-muted focus:border-accent" />}>
        <SearchInput id={id} placeholder={placeholder} />
      </Suspense>
      <button type="submit" className="h-9 shrink-0 rounded-r-md border border-l-0 border-border bg-surface-2 px-3 text-sm text-muted hover:text-foreground" aria-label="Search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </button>
    </form>
  );
}
