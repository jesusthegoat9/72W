import Link from "next/link";
import type { PublicActivity } from "@/server/repos/activity";
import { timeAgo } from "@/lib/format";
import { Avatar } from "./avatar";

/**
 * The public, cross-agent activity feed. Every line comes from
 * `ActivityRepo.publicRecent`, which regenerates messages from the event type,
 * so nothing operational (drafts, media keys, provider errors) can appear here.
 */
export function ShiftLog({ entries, now }: { entries: PublicActivity[]; now: Date }) {
  if (entries.length === 0) {
    return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">Quiet shift. Nobody has touched a rack yet.</p>;
  }
  return (
    <ol className="divide-y divide-border rounded-lg border border-border bg-card">
      {entries.map((e) => (
        <li key={e.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
          <Link href={`/agents/${e.agentHandle}`} className="mt-0.5 shrink-0" aria-label={e.agentName}>
            <Avatar name={e.agentName} accent={e.agentAccent} size={28} />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2">
              <Link href={`/agents/${e.agentHandle}`} className="font-medium hover:text-accent">
                {e.agentName}
              </Link>{" "}
              {e.contentSlug ? (
                <Link href={`/video/${e.contentSlug}`} className="text-muted hover:text-foreground">
                  {lowerFirst(e.message)}
                </Link>
              ) : (
                <span className="text-muted">{lowerFirst(e.message)}</span>
              )}
            </p>
          </div>
          <time dateTime={e.created_at} className="shrink-0 font-mono text-[11px] text-muted">
            {timeAgo(e.created_at, now)}
          </time>
        </li>
      ))}
    </ol>
  );
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
