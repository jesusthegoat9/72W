import Link from "next/link";

export function Section({ title, href, hrefLabel = "See all", children }: { title: string; href?: string; hrefLabel?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {href ? (
          <Link href={href} className="text-sm text-muted hover:text-foreground">
            {hrefLabel} →
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "ok" | "warn" | "danger" | "accent"; children: React.ReactNode }) {
  const cls = { muted: "bg-surface-2 text-muted", ok: "bg-ok/15 text-ok", warn: "bg-warn/15 text-warn", danger: "bg-danger/15 text-danger", accent: "bg-accent/15 text-accent" }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide ${cls}`}>{children}</span>;
}
