import { toBytes, type MediaObject, type MediaStorage } from "./media";

/** In-memory storage for tests. */
export class MemoryMediaStorage implements MediaStorage {
  private readonly objects = new Map<string, { bytes: Uint8Array; meta: MediaObject }>();

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<MediaObject> {
    const bytes = toBytes(body);
    const meta = { key, size: bytes.byteLength, contentType, uploadedAt: new Date().toISOString() };
    this.objects.set(key, { bytes, meta });
    return meta;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { body: o.bytes, contentType: o.meta.contentType } : null;
  }
  async head(key: string) {
    return this.objects.get(key)?.meta ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(prefix = "") {
    return [...this.objects.values()].map((o) => o.meta).filter((m) => m.key.startsWith(prefix));
  }
  publicUrl(key: string) {
    return `/api/media/${key}`;
  }
}
