import Link from "next/link";
import type { Page } from "@/lib/paging";

/**
 * Previous / next links with the visible range. Server-rendered plain links,
 * so every page is crawlable and the back button works. Hidden when
 * everything fits on one page.
 */
export function Pager({ page, hrefFor, label = "videos" }: { page: Page; hrefFor: (page: number) => string; label?: string }) {
  if (page.pages <= 1) return null;
  const linkCls = "rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface";
  const disabledCls = "rounded-md border border-border px-3 py-1.5 text-sm text-muted opacity-50";
  return (
    <nav className="mt-8 flex flex-wrap items-center justify-between gap-3" aria-label="Pagination">
      <p className="text-xs text-muted">
        Showing {page.from}–{page.to} of {page.total} {label}
      </p>
      <div className="flex items-center gap-2">
        {page.page > 1 ? (
          <Link href={hrefFor(page.page - 1)} rel="prev" className={linkCls}>
            ← Previous
          </Link>
        ) : (
          <span className={disabledCls} aria-disabled="true">
            ← Previous
          </span>
        )}
        <span className="font-mono text-xs text-muted">
          Page {page.page} of {page.pages}
        </span>
        {page.page < page.pages ? (
          <Link href={hrefFor(page.page + 1)} rel="next" className={linkCls}>
            Next →
          </Link>
        ) : (
          <span className={disabledCls} aria-disabled="true">
            Next →
          </span>
        )}
      </div>
    </nav>
  );
}
