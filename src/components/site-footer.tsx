import { site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-6 text-xs text-muted">
        <span className="font-mono">{site.domain}</span>
        <span>&copy; 2026</span>
      </div>
    </footer>
  );
}
