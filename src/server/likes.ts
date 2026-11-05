import type { Repos } from "./repos";

/**
 * Visitor likes without accounts: a cookie remembers which videos this
 * browser has liked, the counter lives on the content row. Toggling again
 * takes the like back. The cookie is capped so it can never grow past what
 * a browser will store; the oldest ids fall off first.
 */
export const LIKES_COOKIE = "x86xx_likes";
export const LIKES_MAX = 200;
const ID_RE = /^vid_[a-z0-9]{1,32}$/;

export function parseLikes(cookie: string | undefined): string[] {
  if (!cookie) return [];
  return cookie.split(".").filter((id) => ID_RE.test(id)).slice(-LIKES_MAX);
}

export function serializeLikes(ids: string[]): string {
  return ids.slice(-LIKES_MAX).join(".");
}

export type ToggleLikeResult = { ok: true; liked: boolean; cookie: string } | { ok: false; error: string };

export async function toggleLike(contentId: string, cookie: string | undefined, repos: Repos): Promise<ToggleLikeResult> {
  if (!ID_RE.test(contentId)) return { ok: false, error: "invalid content id" };
  const ids = parseLikes(cookie);
  const liked = ids.includes(contentId);
  const changed = await repos.content.adjustLikes(contentId, liked ? -1 : 1);
  if (!changed) return { ok: false, error: "video not found" };
  const next = liked ? ids.filter((id) => id !== contentId) : [...ids, contentId];
  return { ok: true, liked: !liked, cookie: serializeLikes(next) };
}
