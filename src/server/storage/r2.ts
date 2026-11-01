import { toBytes, type MediaObject, type MediaStorage } from "./media";

/**
 * Structural subset of Cloudflare's R2Bucket binding (declared locally so the
 * app compiles without @cloudflare/workers-types). Matches the documented API.
 */
export interface R2BucketLike {
  put(key: string, value: Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike | null>;
  get(key: string): Promise<(R2ObjectLike & { arrayBuffer(): Promise<ArrayBuffer> }) | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: R2ObjectLike[] }>;
}
export interface R2ObjectLike {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}

/**
 * Production adapter over an R2 bucket binding (env.MEDIA).
 * `publicBase` is the bucket's public/custom-domain URL, if one is configured.
 */
export class R2MediaStorage implements MediaStorage {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly publicBase: string | null = null,
  ) {}

  private meta(o: R2ObjectLike): MediaObject {
    return {
      key: o.key,
      size: o.size,
      contentType: o.httpMetadata?.contentType ?? "application/octet-stream",
      uploadedAt: o.uploaded.toISOString(),
    };
  }

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<MediaObject> {
    const bytes = toBytes(body);
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
    return { key, size: bytes.byteLength, contentType, uploadedAt: new Date().toISOString() };
  }
  async get(key: string) {
    const o = await this.bucket.get(key);
    if (!o) return null;
    return { body: new Uint8Array(await o.arrayBuffer()), contentType: this.meta(o).contentType };
  }
  async head(key: string) {
    const o = await this.bucket.head(key);
    return o ? this.meta(o) : null;
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
  async list(prefix = "") {
    return (await this.bucket.list({ prefix })).objects.map((o) => this.meta(o));
  }
  publicUrl(key: string) {
    return this.publicBase ? `${this.publicBase.replace(/\/$/, "")}/${key}` : `/api/media/${key}`;
  }
}
