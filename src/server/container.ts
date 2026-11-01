import type { SqlDatabase } from "./db/database";
import { createRepos, type Repos } from "./repos";
import type { MediaStorage } from "./storage/media";
import { loadConfig, type AppConfig } from "./config";
import { muteSqliteExperimentalWarning } from "./db/sqlite-warning";

export interface Services {
  config: AppConfig;
  db: SqlDatabase;
  repos: Repos;
  media: MediaStorage;
}

/**
 * Builds the service graph for the current environment.
 *
 * - sqlite (default): node:sqlite file under .data, local filesystem media.
 *   Migrations and seed run automatically so `npm run dev` just works.
 * - cloudflare: D1 + R2 bindings via @opennextjs/cloudflare. The adapter
 *   package is only imported in that mode, so local dev does not need it.
 */
export async function createServices(config: AppConfig = loadConfig()): Promise<Services> {
  if (config.dataBackend === "cloudflare") {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { D1Database } = await import("./db/d1");
    const { R2MediaStorage } = await import("./storage/r2");
    const env = getCloudflareContext().env as unknown as {
      DB: import("./db/d1").D1Like;
      MEDIA: import("./storage/r2").R2BucketLike;
    };
    const db = new D1Database(env.DB);
    // No public bucket URL on purpose: the bucket holds draft and published
    // media side by side, so objects are only served through /api/media,
    // which checks that the owning content is published.
    return { config, db, repos: createRepos(db), media: new R2MediaStorage(env.MEDIA, null) };
  }

  muteSqliteExperimentalWarning();
  const [{ SqliteDatabase }, { LocalFsMediaStorage }, { migrate }, { seedCatalogue }, { seedSimulatedActivity }, fs, path] =
    await Promise.all([
      import("./db/sqlite"),
      import("./storage/local-fs"),
      import("./db/migrate"),
      import("./seed"),
      import("./seed/simulate"),
      import("node:fs/promises"),
      import("node:path"),
    ]);
  const inMemory = config.sqlitePath === ":memory:";
  const file = inMemory ? ":memory:" : path.resolve(process.cwd(), config.sqlitePath);
  if (!inMemory) await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new SqliteDatabase(file);
  await migrate(db);
  const repos = createRepos(db);
  const media = new LocalFsMediaStorage(path.resolve(process.cwd(), config.mediaRoot));
  const services: Services = { config, db, repos, media };
  if ((await seedCatalogue(repos)).seeded) await seedSimulatedActivity(services);
  return services;
}

declare global {
  var __x86xxServices: Promise<Services> | undefined;
}

/** Process-wide singleton. Survives Next dev HMR via globalThis. */
export function getServices(): Promise<Services> {
  if (!globalThis.__x86xxServices) globalThis.__x86xxServices = createServices();
  return globalThis.__x86xxServices;
}
