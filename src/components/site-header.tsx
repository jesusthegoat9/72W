import Link from "next/link";
import { NAV } from "@/lib/nav";
import { Logo } from "./logo";
import { NavLink } from "./nav-link";
import { SearchForm } from "./search-form";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink key={n.href} href={n.href}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <SearchForm id="site-search" className="mx-auto hidden w-full max-w-md sm:flex" />
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/random"
            prefetch={false}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium whitespace-nowrap text-accent-foreground hover:opacity-90"
            title="A random video. No algorithm, no feed, just silicon."
          >
            Random
          </Link>
        </div>
      </div>
      <div className="border-t border-border px-4 py-2 sm:hidden">
        <SearchForm id="site-search-mobile" />
      </div>
      <nav className="scrollbar-none flex gap-1 overflow-x-auto border-t border-border px-2 py-1 md:hidden" aria-label="Primary mobile">
        {NAV.map((n) => (
          <NavLink key={n.href} href={n.href} className="shrink-0">
            {n.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
