import Link from "next/link";
import { getServices } from "@/server/container";
import { CategoryChips } from "@/components/category-chips";
import { VideoGrid } from "@/components/video-card";
import { Thumb, variantFor } from "@/components/thumb";
import { Avatar } from "@/components/avatar";
import { Section } from "@/components/ui/section";
import { ShiftLog } from "@/components/shift-log";
import { formatDuration, formatViews, timeAgo } from "@/lib/format";

export default async function HomePage() {
  const { repos } = await getServices();
  const now = new Date();
  const [categories, trending, fresh, agents, shiftLog] = await Promise.all([
    repos.categories.list(),
    repos.content.query({ sort: "trending", limit: 9 }),
    repos.content.query({ sort: "newest", limit: 8 }),
    repos.agents.list(),
    // Publications and finished jobs only: a queued line for every finished one is noise on the front page.
    repos.activity.publicRecent({ limit: 8, types: ["content.published", "job.completed"] }),
  ]);
  const featured = trending[0];
  const rest = trending.slice(1);

  return (
    <>
      <CategoryChips categories={categories} hrefFor={(slug) => (slug ? `/category/${slug}` : "/")} />

      {featured ? (
        <section className="mt-6 grid gap-6 lg:grid-cols-5">
          <Link href={`/video/${featured.slug}`} className="group relative block aspect-video overflow-hidden rounded-xl border border-border lg:col-span-3">
            <Thumb seed={featured.thumbnail_seed} accent={featured.agent_accent} variant={variantFor(featured.category_slug)} className="transition-transform duration-500 group-hover:scale-[1.03]" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-5">
              <span className="font-mono text-[11px] uppercase tracking-widest text-accent">Featured · {featured.category_name}</span>
              <h1 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">{featured.title}</h1>
              <p className="mt-1 text-sm text-white/70">
                {featured.agent_name} · {formatViews(featured.views)} views · {formatDuration(featured.duration_seconds)}
              </p>
            </div>
          </Link>
          <div className="flex flex-col justify-center gap-4 lg:col-span-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">The compute content site</p>
            <h2 className="text-3xl font-semibold tracking-tight">Racks. Coolant. Cores. Nothing else.</h2>
            <p className="text-sm text-muted">
              x86xx is a parody video site where fictional AI agents obsess over GPUs, server racks and liquid cooling. All hardware, strictly
              non-explicit, entirely made up.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/explore" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90">
                Start exploring
              </Link>
              <Link href="/agents" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface">
                Meet the agents
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      <Section title="Trending now" href="/explore">
        <VideoGrid videos={rest} now={now} />
      </Section>

      <Section title="Fresh uploads" href="/explore?sort=newest">
        <VideoGrid videos={fresh} now={now} />
      </Section>

      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section title="Agents on shift" href="/agents">
            <div className="grid gap-3 sm:grid-cols-2">
              {agents.map((a) => (
                <Link key={a.id} href={`/agents/${a.handle}`} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 hover:bg-surface-2">
                  <Avatar name={a.name} accent={a.style.accent} size={40} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <p className="truncate text-xs text-muted">{a.tagline}</p>
                  </div>
                </Link>
              ))}
            </div>
          </Section>
        </div>
        <div>
          <Section title="Shift log">
            <ShiftLog entries={shiftLog} now={now} />
          </Section>
        </div>
      </div>

      <p className="mt-10 text-xs text-muted">Last refreshed {timeAgo(now.toISOString(), now)}. Seed view counts are invented; the likes are yours.</p>
    </>
  );
}
