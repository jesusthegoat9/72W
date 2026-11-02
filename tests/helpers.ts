import { SqliteDatabase } from "@/server/db/sqlite";
import { migrate } from "@/server/db/migrate";
import { createRepos, type Repos } from "@/server/repos";
import { seedCatalogue } from "@/server/seed";
import { loadConfig, type AppConfig } from "@/server/config";
import { MemoryMediaStorage } from "@/server/storage/memory";

export async function freshRepos(opts: { seed?: boolean } = {}): Promise<{ db: SqliteDatabase; repos: Repos }> {
  const db = new SqliteDatabase(":memory:");
  await migrate(db);
  const repos = createRepos(db);
  if (opts.seed !== false) await seedCatalogue(repos, { now: new Date("2026-11-01T00:00:00Z") });
  return { db, repos };
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig(), maxJobsPerRun: 10, retryBackoffSeconds: 0, ...overrides };
}

export function memoryMedia() {
  return new MemoryMediaStorage();
}

/**
 * Flattens a server-component tree to text for assertions: expands server
 * components (sync and async) by calling them, keeps `href`/`title` props,
 * and walks data props and unexpandable client components as plain data so
 * anything handed to them still shows up. Not a DOM renderer; good enough to
 * check what a page shows and, more importantly, what it must never show.
 */
export async function renderText(el: unknown): Promise<string> {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const push = (s: string) => {
    if (s) out.push(s);
  };
  const walk = async (node: unknown): Promise<void> => {
    if (node == null || typeof node === "boolean" || typeof node === "function" || typeof node === "symbol") return;
    if (typeof node === "string" || typeof node === "number") return push(String(node));
    if (typeof node !== "object") return;
    if (node instanceof Promise) return walk(await node);
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      // Adjacent text and numbers in one children array are a single run ("Showing ", 1, "–", 24).
      let run = "";
      for (const child of node) {
        if (typeof child === "string" || typeof child === "number") run += String(child);
        else {
          push(run);
          run = "";
          await walk(child);
        }
      }
      return push(run);
    }
    const element = node as { type?: unknown; props?: Record<string, unknown> };
    if (element.props && "type" in element) {
      const { type, props } = element;
      if (typeof type === "function") {
        try {
          const result = (type as (p: unknown) => unknown)(props);
          return await walk(result instanceof Promise ? await result : result);
        } catch {
          // Client components using hooks cannot run outside React; fall through to their props.
        }
      }
      if (typeof props.href === "string") push(props.href);
      if (typeof props.title === "string") push(props.title);
      for (const [key, value] of Object.entries(props)) if (key !== "href" && key !== "title") await walk(value);
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) await walk(value);
  };
  await walk(el);
  return out.join(" ");
}
