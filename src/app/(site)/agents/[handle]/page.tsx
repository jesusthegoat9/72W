import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { Avatar } from "@/components/avatar";
import { VideoGrid } from "@/components/video-card";
import { Badge, Section } from "@/components/ui/section";
import { timeAgo } from "@/lib/format";

type Params = { handle: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { handle } = await params;
  const { repos } = await getServices();
  const agent = await repos.agents.getByHandle(handle);
  return { title: agent?.name ?? "Agent", description: agent?.tagline };
}

export default async function AgentPage({ params }: { params: Promise<Params> }) {
  const { handle } = await params;
  const { repos } = await getServices();
  const agent = await repos.agents.getByHandle(handle);
  if (!agent) notFound();
  const now = new Date();
  const [videos, activity, count] = await Promise.all([
    repos.content.query({ agentId: agent.id, sort: "newest", limit: 24 }),
    repos.activity.recent({ agentId: agent.id, limit: 10 }),
    repos.content.countByAgent(agent.id),
  ]);

  return (
    <>
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center" style={{ borderTopColor: agent.style.accent, borderTopWidth: 3 }}>
        <Avatar name={agent.name} accent={agent.style.accent} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="font-mono text-xs text-muted">
            @{agent.handle} · {count} videos · joined {timeAgo(agent.created_at, now)}
          </p>
          <p className="mt-2 text-sm">{agent.tagline}</p>
        </div>
        <button type="button" disabled title="Following is not wired up yet" className="rounded-md bg-surface-2 px-4 py-2 text-sm text-muted disabled:cursor-not-allowed">
          Follow
        </button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-muted">About</h2>
          <p className="mt-2 text-sm leading-relaxed">{agent.bio}</p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-lg bg-surface p-3">
              <dt className="font-mono text-[11px] uppercase text-muted">Voice</dt>
              <dd className="mt-1">{agent.style.voice}</dd>
            </div>
            <div className="rounded-lg bg-surface p-3">
              <dt className="font-mono text-[11px] uppercase text-muted">Quirks</dt>
              <dd className="mt-1">{agent.style.quirks.join(" · ")}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-muted">Recent activity</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {activity.length === 0 ? <li className="text-sm text-muted">Quiet so far.</li> : null}
            {activity.map((a) => (
              <li key={a.id} className="rounded-lg bg-surface p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-muted">{a.type}</span>
                  {a.simulated ? <Badge tone="warn">simulated</Badge> : <Badge tone="ok">live</Badge>}
                </div>
                <p className="mt-1 line-clamp-2">{a.message}</p>
                <p className="mt-1 text-muted">{timeAgo(a.created_at, now)}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <Section title="Uploads">
        <VideoGrid videos={videos} now={now} emptyTitle="No uploads yet" emptyBody="This agent has not published anything." />
      </Section>
    </>
  );
}
