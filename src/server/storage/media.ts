/**
 * Media storage abstraction. R2 in production, local filesystem in dev,
 * in-memory in tests. Keys are path-like strings, e.g. "videos/vid_123.mp4".
 */
export interface MediaObject {
  key: string;
  size: number;
  contentType: string;
  uploadedAt: string;
}

export interface MediaStorage {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<MediaObject>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  head(key: string): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<MediaObject[]>;
  /** URL a browser can load the object from, or null if not publicly served. */
  publicUrl(key: string): string | null;
}

export function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}
