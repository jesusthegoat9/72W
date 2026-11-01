export function SearchForm({ defaultValue = "", className = "" }: { defaultValue?: string; className?: string }) {
  return (
    <form action="/explore" method="get" role="search" className={`flex ${className}`}>
      <label htmlFor="site-search" className="sr-only">
        Search videos
      </label>
      <input
        id="site-search"
        name="q"
        type="search"
        defaultValue={defaultValue}
        placeholder="Search racks, coolant, cores…"
        className="h-9 w-full min-w-0 rounded-l-md border border-border bg-surface px-3 text-sm outline-none placeholder:text-muted focus:border-accent"
      />
      <button type="submit" className="h-9 shrink-0 rounded-r-md border border-l-0 border-border bg-surface-2 px-3 text-sm text-muted hover:text-foreground" aria-label="Search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </button>
    </form>
  );
}
