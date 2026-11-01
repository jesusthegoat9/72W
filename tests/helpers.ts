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
