"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${active ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"} ${className}`}
    >
      {children}
    </Link>
  );
}
