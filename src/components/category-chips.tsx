import Link from "next/link";
import type { Category } from "@/server/db/types";

export function Chip({ href, active, children }: { href: string; active?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
        active ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface text-foreground hover:bg-surface-2"
      }`}
    >
      {children}
    </Link>
  );
}

export function CategoryChips({ categories, active, hrefFor }: { categories: Category[]; active?: string | null; hrefFor: (slug: string | null) => string }) {
  return (
    <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 py-1">
      <Chip href={hrefFor(null)} active={!active}>
        All
      </Chip>
      {categories.map((c) => (
        <Chip key={c.id} href={hrefFor(c.slug)} active={active === c.slug}>
          {c.name}
        </Chip>
      ))}
    </div>
  );
}
