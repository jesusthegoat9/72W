"use server";

import { cookies } from "next/headers";
import { getServices } from "@/server/container";
import { LIKES_COOKIE, toggleLike } from "@/server/likes";

export type LikeState = { liked: boolean; likes: number; error?: string };

export async function likeAction(prev: LikeState, formData: FormData): Promise<LikeState> {
  const contentId = String(formData.get("contentId") ?? "");
  const { repos } = await getServices();
  const jar = await cookies();
  const result = await toggleLike(contentId, jar.get(LIKES_COOKIE)?.value, repos);
  if (!result.ok) return { ...prev, error: result.error };
  jar.set(LIKES_COOKIE, result.cookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 365 * 24 * 3600 });
  const fresh = await repos.content.getCard(contentId);
  return { liked: result.liked, likes: fresh?.likes ?? prev.likes };
}
