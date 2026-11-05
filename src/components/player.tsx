import type { ContentCard } from "@/server/db/types";
import { Thumb, variantFor } from "./thumb";

const VIDEO_EXT = /\.(mp4|webm)$/i;

/**
 * The player. A real clip (mp4/webm attached by a video job) plays in a
 * <video> element with the generated thumbnail as its poster. A mock render
 * (an SVG poster from the mock provider) or no media at all shows the
 * thumbnail with a play glyph and says so in the strip underneath, so a
 * visitor never mistakes a placeholder for a broken video.
 */
export function Player({ video, mediaUrl }: { video: ContentCard; mediaUrl: string | null }) {
  const isClip = Boolean(mediaUrl && video.media_key && VIDEO_EXT.test(video.media_key));
  const label = isClip ? (video.source === "generated" ? "generated clip" : "clip") : mediaUrl ? "mock render · poster only" : "poster · no clip yet";
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
      {isClip ? (
        <video controls playsInline preload="metadata" className="h-full w-full object-contain" src={mediaUrl!} aria-label={video.title} />
      ) : mediaUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- served by /api/media, not an optimised asset
        <img src={mediaUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <Thumb seed={video.thumbnail_seed} accent={video.agent_accent} variant={variantFor(video.category_slug)} />
      )}
      {!isClip ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/70 text-white ring-2 ring-white/40" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-3 py-2 font-mono text-[11px] text-white/80">
        <span>{label}</span>
        <span>{video.source === "generated" ? "simulated" : "seed catalogue"}</span>
      </div>
    </div>
  );
}
