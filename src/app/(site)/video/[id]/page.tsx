import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/server/container";
import { cookies } from "next/headers";
import { Player } from "@/components/player";
import { LikeButton } from "@/components/like-button";
import { LIKES_COOKIE, parseLikes } from "@/server/likes";
import { Avatar } from "@/components/avatar";
import { VideoCard } from "@/components/video-card";
import { Badge } from "@/components/ui/section";
import { formatViews, timeAgo } from "@/lib/format";

type Params = { id: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await params;
  const { repos } = await getServices();
  const video = await repos.content.getCard(id);
  return { title: video?.title ?? "Video", description: video?.description };
}

export default async function VideoPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;
  const { repos, media } = await getServices();
  const video = await repos.content.getCard(id);
  if (!video || video.status !== "published") notFound();
  const now = new Date();
  const [related, agent] = await Promise.all([repos.content.related(video, 8), repos.agents.getById(video.agent_id)]);
  const mediaUrl = video.media_key ? media.publicUrl(video.media_key) : null;
  const liked = parseLikes((await cookies()).get(LIKES_COOKIE)?.value).includes(video.id);
  // Fire-and-forget view count. Placeholder analytics, not real.
  void repos.content.incrementViews(video.id).catch(() => {});

  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Player video={video} mediaUrl={mediaUrl} />
        <h1 className="mt-4 text-xl font-semibold tracking-tight sm:text-2xl">{video.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>{formatViews(video.views)} views</span>
          <span>·</span>
          <span>{timeAgo(video.published_at, now)}</span>
          <span>·</span>
          <Link href={`/category/${video.category_slug}`} className="hover:text-foreground">
            {video.category_name}
          </Link>
          {video.source === "generated" ? <Badge tone="warn">simulated</Badge> : null}
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3">
          <Link href={`/agents/${video.agent_handle}`} className="flex min-w-0 items-center gap-3">
            <Avatar name={video.agent_name} accent={video.agent_accent} size={44} />
            <div className="min-w-0">
              <p className="truncate font-medium">{video.agent_name}</p>
              <p className="truncate text-xs text-muted">{agent?.tagline}</p>
            </div>
          </Link>
          <div className="flex shrink-0 gap-2">
            <LikeButton contentId={video.id} likes={video.likes} liked={liked} />
          </div>
        </div>

        <div className="mt-4 rounded-lg bg-surface p-4">
          <p className="text-sm leading-relaxed whitespace-pre-line">{video.description}</p>
          {video.tags.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {video.tags.map((t) => (
                <Link key={t} href={`/explore?q=${encodeURIComponent(t)}`} className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted hover:text-foreground">
                  #{t.replace(/\s+/g, "-")}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <aside>
        <h2 className="mb-3 text-sm font-semibold text-muted">Up next</h2>
        <div className="flex flex-col gap-4">
          {related.map((v) => (
            <VideoCard key={v.id} video={v} now={now} />
          ))}
        </div>
      </aside>
    </div>
  );
}
