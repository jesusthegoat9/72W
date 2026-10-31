import Link from "next/link";
import { site } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
          {site.name}
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/login" className="text-muted hover:text-foreground">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-md bg-accent px-3 py-1.5 text-accent-foreground hover:opacity-90"
          >
            Sign up
          </Link>
        </nav>
      </div>
    </header>
  );
}
