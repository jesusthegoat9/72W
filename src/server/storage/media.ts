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

/**
 * The only media types the site stores and serves. A provider that returns
 * anything else fails the job instead of parking an unknown blob next to the
 * published renders, and /api/media never sniffs: unknown types would be sent
 * as a download, but they are refused before they are stored.
 */
export const ALLOWED_MEDIA_TYPES: readonly string[] = ["video/mp4", "video/webm", "image/svg+xml", "image/png", "image/jpeg", "image/webp"];

/** Normalises a content-type header (drops parameters, lower-cases) and checks it against the allow list. */
export function normalizeMediaType(contentType: string | null | undefined): string | null {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return ALLOWED_MEDIA_TYPES.includes(base) ? base : null;
}

export function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}
