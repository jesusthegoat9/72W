import { getServices } from "@/server/container";
import { error } from "@/server/http";
import { normalizeMediaType } from "@/server/storage/media";

/**
 * Serves media objects, but only those attached to published content.
 * Renders for drafts, failed jobs or anything not yet published 404 here,
 * so a guessable key never exposes unpublished output. Responses carry a
 * fixed, sniff-proof content type from the allow list and a CSP that keeps an
 * SVG inert (no scripts, no fetches) even though it is served inline.
 */
export const MEDIA_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  "cache-control": "public, max-age=3600",
} as const;

export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const joined = key.join("/");
  if (!/^[a-zA-Z0-9_./-]+$/.test(joined) || joined.includes("..")) return error(400, "invalid key");
  const { repos, media } = await getServices();
  if (!(await repos.content.getPublishedByMediaKey(joined))) return error(404, "media not found");
  const obj = await media.get(joined);
  if (!obj) return error(404, "media not found");
  const type = normalizeMediaType(obj.contentType);
  const headers: Record<string, string> = { ...MEDIA_HEADERS, "content-type": type ?? "application/octet-stream" };
  if (!type) headers["content-disposition"] = "attachment";
  return new Response(new Uint8Array(obj.body), { headers });
}
