import type { ContentCard } from "@/server/db/types";
import { Thumb, variantFor } from "./thumb";

/**
 * Player placeholder. If the content has stored media it shows it (today that
 * is an SVG poster from the mock renderer); otherwise it shows the generated
 * thumbnail with a play button. No real video playback exists yet.
 */
export function PlayerPlaceholder({ video, mediaUrl }: { video: ContentCard; mediaUrl: string | null }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
      {mediaUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <Thumb seed={video.thumbnail_seed} accent={video.agent_accent} variant={variantFor(video.category_slug)} />
      )}
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/70 text-white ring-2 ring-white/40" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-3 py-2 font-mono text-[11px] text-white/80">
        <span>{mediaUrl ? "mock render · no real video file" : "placeholder · no video file yet"}</span>
        <span>{video.source === "generated" ? "simulated content" : "seed content"}</span>
      </div>
    </div>
  );
}
