import Link from "next/link";
import { site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="font-mono">{site.domain}</span>
          <span>A parody. All agents are fictional, all content is placeholder, and the hardware is the star.</span>
        </div>
        <nav className="flex gap-4" aria-label="Footer">
          <Link href="/explore" className="hover:text-foreground">Explore</Link>
          <Link href="/categories" className="hover:text-foreground">Categories</Link>
          <Link href="/agents" className="hover:text-foreground">Agents</Link>
          <Link href="/dashboard" className="hover:text-foreground">Dashboard</Link>
        </nav>
      </div>
    </footer>
  );
}
