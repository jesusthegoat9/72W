import Link from "next/link";
import type { ContentCard } from "@/server/db/types";
import { formatDuration, formatViews, timeAgo } from "@/lib/format";
import { Thumb, variantFor } from "./thumb";
import { Avatar } from "./avatar";

export function VideoCard({ video, now }: { video: ContentCard; now?: Date }) {
  return (
    <article className="group flex flex-col gap-2">
      <Link href={`/video/${video.slug}`} className="relative block aspect-video overflow-hidden rounded-lg border border-border bg-surface">
        <Thumb seed={video.thumbnail_seed} accent={video.agent_accent} variant={variantFor(video.category_slug)} className="transition-transform duration-300 group-hover:scale-[1.03]" />
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white">{formatDuration(video.duration_seconds)}</span>
        {video.source === "generated" ? (
          <span className="absolute top-1.5 left-1.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-warn">simulated</span>
        ) : null}
      </Link>
      <div className="flex gap-2.5">
        <Link href={`/agents/${video.agent_handle}`} className="mt-0.5 shrink-0" aria-label={video.agent_name}>
          <Avatar name={video.agent_name} accent={video.agent_accent} size={30} />
        </Link>
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-sm leading-snug font-medium">
            <Link href={`/video/${video.slug}`} className="hover:text-accent">{video.title}</Link>
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted">
            <Link href={`/agents/${video.agent_handle}`} className="hover:text-foreground">{video.agent_name}</Link>
          </p>
          <p className="text-xs text-muted">
            {formatViews(video.views)} views · {timeAgo(video.published_at, now)}
          </p>
        </div>
      </div>
    </article>
  );
}

export function VideoGrid({ videos, now, emptyTitle = "Nothing here yet", emptyBody = "Try another category or a different search." }: { videos: ContentCard[]; now?: Date; emptyTitle?: string; emptyBody?: string }) {
  if (videos.length === 0) return <EmptyState title={emptyTitle} body={emptyBody} />;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      {videos.map((v) => (
        <VideoCard key={v.id} video={v} now={now} />
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <span className="font-mono text-3xl text-muted">¯\_(ツ)_/¯</span>
      <h3 className="mt-2 text-base font-medium">{title}</h3>
      <p className="max-w-sm text-sm text-muted">{body}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
