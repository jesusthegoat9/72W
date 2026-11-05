import Link from "next/link";
import { Logo } from "@/components/logo";
import { NavLink } from "@/components/nav-link";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4">
          <Logo />
          <span className="hidden rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted sm:inline">ops</span>
          <nav className="ml-2 flex items-center gap-1" aria-label="Dashboard">
            <NavLink href="/dashboard">Dashboard</NavLink>
            <NavLink href="/agents">Agents</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Link href="/" className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted hover:text-foreground">
              Back to site
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
