import type { Metadata } from "next";
import Link from "next/link";
import { getServices } from "@/server/container";
import { currentOperator } from "@/lib/operator";
import { logout } from "@/app/(auth)/actions";
import { EnqueueForm, RunDispatcherForm } from "@/components/ops-forms";
import { Avatar } from "@/components/avatar";
import { Badge } from "@/components/ui/section";
import { timeAgo } from "@/lib/format";
import type { JobStatus } from "@/server/db/types";

export const metadata: Metadata = { title: "Dashboard" };

const statusTone: Record<JobStatus, "muted" | "ok" | "warn" | "danger"> = { queued: "muted", processing: "warn", completed: "ok", failed: "danger" };

export default async function DashboardPage() {
  const { repos, config } = await getServices();
  const now = new Date();
  const hasSession = Boolean(await currentOperator());
  const [agents, categories, published, drafts, jobCounts, jobs, activity, generated] = await Promise.all([
    repos.agents.list(),
    repos.categories.list(),
    repos.content.count("published"),
    repos.content.count("draft"),
    repos.jobs.counts(),
    repos.jobs.list({ limit: 20 }),
    repos.activity.recent({ limit: 25 }),
    repos.content.query({ status: "any", sort: "newest", limit: 100 }).then((all) => all.filter((c) => c.source === "generated").slice(0, 12)),
  ]);
  const agentCounts = await Promise.all(agents.map((a) => repos.content.countByAgent(a.id)));
  const agentById = new Map(agents.map((a) => [a.id, a]));

  return (
    <>
      {!hasSession ? (
        <div className="mb-6 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <strong className="font-medium">Development preview.</strong> No operator session. This page is only reachable without one in{" "}
          <code className="font-mono">next dev</code>; production redirects to <code className="font-mono">/login</code>.
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent operations</h1>
          <p className="mt-1 text-sm text-muted">Jobs, activity and generated content. Everything queued here is a dry run against the mock providers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={config.liveGenerationEnabled ? "danger" : "ok"}>live generation {config.liveGenerationEnabled ? "ENABLED" : "off"}</Badge>
          <Badge tone="muted">dry run default {config.dryRunDefault ? "on" : "off"}</Badge>
          {hasSession ? (
            <form action={logout}>
              <button type="submit" className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground">
                Log out
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <section className="mt-6 grid gap-4 rounded-lg border border-border bg-card p-4 lg:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold">Queue a dry-run job</h2>
          <p className="mt-1 mb-3 text-xs text-muted">Creates a text listing in the agent&apos;s voice, optionally chained to a mock render. No provider is called.</p>
          <EnqueueForm agents={agents.map((a) => ({ handle: a.handle, name: a.name }))} categories={categories.map((c) => ({ slug: c.slug, name: c.name }))} />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Dispatcher</h2>
          <p className="mt-1 mb-3 text-xs text-muted">Runs one pass: claims up to {config.maxJobsPerRun} queued jobs, polls in-flight renders, publishes finished dry runs.</p>
          <RunDispatcherForm />
        </div>
      </section>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Agents", agents.length],
          ["Published", published],
          ["Drafts", drafts],
          ["Queued", jobCounts.queued],
          ["Completed jobs", jobCounts.completed],
          ["Failed jobs", jobCounts.failed],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-1 font-mono text-2xl">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-3">
        <section className="min-w-0 lg:col-span-2">
          <h2 className="text-sm font-semibold text-muted">Recent jobs</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Job</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted">No jobs yet. Queue one above.</td>
                  </tr>
                ) : null}
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/api/jobs/${j.id}`} className="hover:text-accent">{j.id.slice(0, 12)}</Link>
                      {j.last_error ? <p className="mt-1 max-w-xs truncate text-danger" title={j.last_error}>{j.last_error}</p> : null}
                    </td>
                    <td className="px-3 py-2">{agentById.get(j.agent_id)?.name ?? j.agent_id}</td>
                    <td className="px-3 py-2">{j.kind}</td>
                    <td className="px-3 py-2"><Badge tone={statusTone[j.status]}>{j.status}</Badge></td>
                    <td className="px-3 py-2 font-mono text-xs">{j.attempts}/{j.max_attempts}</td>
                    <td className="px-3 py-2 font-mono text-xs">{j.provider}{j.dryRun ? " · dry" : " · LIVE"}</td>
                    <td className="px-3 py-2 text-xs text-muted">{timeAgo(j.updated_at, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="mt-8 text-sm font-semibold text-muted">Generated content</h2>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {generated.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted">Nothing generated yet.</li> : null}
            {generated.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Avatar name={c.agent_name} accent={c.agent_accent} size={24} />
                <div className="min-w-0 flex-1">
                  <Link href={`/video/${c.slug}`} className="block truncate hover:text-accent">{c.title}</Link>
                  <p className="truncate text-xs text-muted">{c.agent_name} · {c.category_name} · {c.media_key ? `media: ${c.media_key}` : "no media"}</p>
                </div>
                <Badge tone={c.status === "published" ? "ok" : "muted"}>{c.status}</Badge>
                <Badge tone="warn">simulated</Badge>
              </li>
            ))}
          </ul>
        </section>

        <aside>
          <h2 className="text-sm font-semibold text-muted">Agents</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {agents.map((a, i) => (
              <li key={a.id} className="flex items-center gap-3 rounded-lg border border-border bg-card p-2.5 text-sm">
                <Avatar name={a.name} accent={a.style.accent} size={28} />
                <Link href={`/agents/${a.handle}`} className="min-w-0 flex-1 truncate hover:text-accent">{a.name}</Link>
                <span className="font-mono text-xs text-muted">{agentCounts[i]} videos</span>
              </li>
            ))}
          </ul>

          <h2 className="mt-8 text-sm font-semibold text-muted">Activity</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {activity.map((a) => (
              <li key={a.id} className="rounded-lg bg-surface p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-muted">{a.type}</span>
                  {a.simulated ? <Badge tone="warn">simulated</Badge> : <Badge tone="ok">live</Badge>}
                </div>
                <p className="mt-1 line-clamp-2">{a.message}</p>
                <p className="mt-1 text-muted">{timeAgo(a.created_at, now)}</p>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </>
  );
}
