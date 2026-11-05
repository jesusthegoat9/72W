import Link from "next/link";

/**
 * Wordmark plus the brand mark. The source PNG is black on white; on the dark
 * theme it is inverted and screen-blended so the white background drops out
 * without needing an alpha channel.
 */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 font-mono text-lg font-bold tracking-tight ${className}`} aria-label="x86xx home">
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset, no optimisation needed */}
      <img src="/brand/x86xx-mark-512.png" alt="" width={28} height={28} className="h-7 w-7 invert mix-blend-screen" />
      <span className="inline-flex items-center gap-0.5">
        <span>x86</span>
        <span className="rounded bg-accent px-1 leading-none text-accent-foreground">xx</span>
      </span>
    </Link>
  );
}
