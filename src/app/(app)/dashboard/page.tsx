import type { Metadata } from "next";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-2 text-sm text-muted">
        This route is protected by <code className="font-mono">src/proxy.ts</code>. You only see it
        with a session cookie.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {["Overview", "Activity", "Settings"].map((label) => (
          <div key={label} className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-medium">{label}</h2>
            <p className="mt-1 text-xs text-muted">Nothing here yet.</p>
          </div>
        ))}
      </div>
    </>
  );
}
