import Link from "next/link";
import { site } from "@/lib/site";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <Link href="/dashboard" className="font-mono text-sm font-semibold">
            {site.name}
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted">
            <Link href="/dashboard" className="hover:text-foreground">
              Dashboard
            </Link>
            <Link href="/" className="hover:text-foreground">
              Log out
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">{children}</main>
    </div>
  );
}
