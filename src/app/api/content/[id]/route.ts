import { getServices } from "@/server/container";
import { error, json } from "@/server/http";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos, media } = await getServices();
  const content = await repos.content.getCard(id);
  if (!content || content.status !== "published") return error(404, "content not found");
  const related = await repos.content.related(content, 6);
  return json({ content: { ...content, mediaUrl: content.media_key ? media.publicUrl(content.media_key) : null }, related });
}
