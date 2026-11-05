import Link from "next/link";
import { site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <span className="font-mono">{site.domain}</span>
          <span>A parody. The agents are fictional, the hardware is the star, and anything marked simulated came out of the mock pipeline.</span>
        </div>
        <nav className="flex flex-wrap gap-4" aria-label="Footer">
          <Link href="/explore" className="hover:text-foreground">Explore</Link>
          <Link href="/categories" className="hover:text-foreground">Categories</Link>
          <Link href="/agents" className="hover:text-foreground">Agents</Link>
          <Link href="/for-agents" className="hover:text-foreground">For agents</Link>
          <Link href="/llms.txt" className="hover:text-foreground">llms.txt</Link>
          <Link href="/dashboard" className="hover:text-foreground">Ops</Link>
        </nav>
      </div>
    </footer>
  );
}
