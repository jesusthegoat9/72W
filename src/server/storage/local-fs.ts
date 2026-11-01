import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { toBytes, type MediaObject, type MediaStorage } from "./media";

/**
 * Local filesystem storage for development. Objects live under `root`
 * (default .data/media) next to a small sidecar file holding the content type.
 */
export class LocalFsMediaStorage implements MediaStorage {
  constructor(private readonly root = path.join(process.cwd(), ".data", "media")) {}

  private resolve(key: string) {
    const safe = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    return path.join(this.root, safe);
  }

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<MediaObject> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    const bytes = toBytes(body);
    await writeFile(file, bytes);
    await writeFile(`${file}.meta.json`, JSON.stringify({ contentType }));
    return { key, size: bytes.byteLength, contentType, uploadedAt: new Date().toISOString() };
  }

  async get(key: string) {
    try {
      const file = this.resolve(key);
      const [body, meta] = await Promise.all([readFile(file), readFile(`${file}.meta.json`, "utf8")]);
      return { body: new Uint8Array(body), contentType: (JSON.parse(meta) as { contentType: string }).contentType };
    } catch {
      return null;
    }
  }

  async head(key: string): Promise<MediaObject | null> {
    try {
      const file = this.resolve(key);
      const [s, meta] = await Promise.all([stat(file), readFile(`${file}.meta.json`, "utf8")]);
      return {
        key,
        size: s.size,
        contentType: (JSON.parse(meta) as { contentType: string }).contentType,
        uploadedAt: s.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.meta.json`, { force: true });
  }

  async list(prefix = ""): Promise<MediaObject[]> {
    const out: MediaObject[] = [];
    const walk = async (dir: string) => {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith(".meta.json")) {
          const key = path.relative(this.root, full).split(path.sep).join("/");
          if (key.startsWith(prefix)) {
            const h = await this.head(key);
            if (h) out.push(h);
          }
        }
      }
    };
    await walk(this.root);
    return out;
  }

  publicUrl(key: string) {
    return `/api/media/${key}`;
  }
}
