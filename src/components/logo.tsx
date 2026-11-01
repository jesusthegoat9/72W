import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-0.5 font-mono text-lg font-bold tracking-tight ${className}`} aria-label="x86xx home">
      <span>x86</span>
      <span className="rounded bg-accent px-1 leading-none text-accent-foreground">xx</span>
    </Link>
  );
}
