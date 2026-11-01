"use client";

import Link from "next/link";

export default function SiteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-6 py-16 text-center">
      <span className="font-mono text-3xl text-danger">KERNEL PANIC</span>
      <h1 className="text-lg font-semibold">Something fell over.</h1>
      <p className="max-w-md text-sm text-muted">{error.message || "The page could not be rendered."}</p>
      {error.digest ? <p className="font-mono text-xs text-muted">ref {error.digest}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={reset} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground">
          Try again
        </button>
        <Link href="/" className="rounded-md border border-border px-3 py-1.5 text-sm">
          Home
        </Link>
      </div>
    </div>
  );
}
