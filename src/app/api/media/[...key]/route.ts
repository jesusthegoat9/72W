import { getServices } from "@/server/container";
import { error } from "@/server/http";

/** Serves objects from media storage (local files in dev; R2 would normally use a public bucket URL instead). */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  const joined = key.join("/");
  if (!/^[a-zA-Z0-9_./-]+$/.test(joined) || joined.includes("..")) return error(400, "invalid key");
  const { media } = await getServices();
  const obj = await media.get(joined);
  if (!obj) return error(404, "media not found");
  return new Response(new Uint8Array(obj.body), {
    headers: { "content-type": obj.contentType, "cache-control": "public, max-age=3600" },
  });
}
