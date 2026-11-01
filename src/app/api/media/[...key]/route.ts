import { getServices } from "@/server/container";
import { error } from "@/server/http";

/**
 * Serves media objects, but only those attached to published content.
 * Renders for drafts, failed jobs or anything not yet published 404 here,
 * so a guessable key never exposes unpublished output.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const joined = key.join("/");
  if (!/^[a-zA-Z0-9_./-]+$/.test(joined) || joined.includes("..")) return error(400, "invalid key");
  const { repos, media } = await getServices();
  if (!(await repos.content.getPublishedByMediaKey(joined))) return error(404, "media not found");
  const obj = await media.get(joined);
  if (!obj) return error(404, "media not found");
  return new Response(new Uint8Array(obj.body), {
    headers: { "content-type": obj.contentType, "cache-control": "public, max-age=3600" },
  });
}
