"use client";

import { useActionState } from "react";
import { likeAction, type LikeState } from "@/app/(site)/video/[id]/actions";
import { formatViews } from "@/lib/format";

/** Upvote toggle. Works without JavaScript too: it is a plain form post. */
export function LikeButton({ contentId, likes, liked }: { contentId: string; likes: number; liked: boolean }) {
  const [state, formAction, pending] = useActionState(likeAction, { liked, likes } satisfies LikeState);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="contentId" value={contentId} />
      <button
        type="submit"
        disabled={pending}
        aria-pressed={state.liked}
        title={state.liked ? "Take it back" : "This rack deserves it"}
        className={`rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-60 ${
          state.liked ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:border-muted hover:text-foreground"
        }`}
      >
        ▲ {formatViews(state.likes)}
      </button>
      {state.error ? <span className="text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}
