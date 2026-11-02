/**
 * Local database maintenance.
 *   npm run db:migrate   apply pending migrations to .data/x86xx.db (and seed if empty)
 *   npm run db:seed      alias of migrate
 *   npm run db:reset     delete the local db + media and rebuild from scratch
 *   npm run db:check     report pending migrations and duplicate job content without writing to the database
 *                        (read-only connection; a WAL database's -wal/-shm sidecar files may still be touched)
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/server/config";
import { createServices } from "../src/server/container";
import { findDuplicateJobContent, pendingMigrations } from "../src/server/db/migrate";
import { muteSqliteExperimentalWarning } from "../src/server/db/sqlite-warning";

async function main() {
  const cmd = process.argv[2] ?? "migrate";
  const config = loadConfig();

  if (cmd === "check") {
    // Preflight: read-only, no migrations, no seeding, no file created.
    muteSqliteExperimentalWarning();
    const file = path.resolve(process.cwd(), config.sqlitePath);
    if (!existsSync(file)) {
      console.log(`db: ${config.sqlitePath} does not exist yet; every migration is pending and there is nothing to reconcile.`);
      return;
    }
    const { SqliteDatabase } = await import("../src/server/db/sqlite");
    const db = new SqliteDatabase(file, { readOnly: true });
    const pending = await pendingMigrations(db);
    const hasContent = await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'content'").first();
    const dupes = hasContent ? await findDuplicateJobContent(db) : [];
    console.log(`db: ${config.sqlitePath}`);
    console.log(`pending migrations: ${pending.length ? pending.join(", ") : "none"}`);
    if (dupes.length) {
      console.log(`jobs with more than one content row (0002b will keep job_id on the row the job points at, else the earliest, and park the rest in legacy_job_id):`);
      for (const d of dupes) console.log(`  ${d.job_id}: ${d.ids}`);
    } else {
      console.log("duplicate job content: none");
    }
    db.close();
    return;
  }

  if (cmd === "reset") {
    const db = path.resolve(process.cwd(), config.sqlitePath);
    for (const f of [db, `${db}-wal`, `${db}-shm`]) await rm(f, { force: true });
    await rm(path.resolve(process.cwd(), config.mediaRoot), { recursive: true, force: true });
    console.log("removed local database and media");
  }

  const services = await createServices(config);
  const [agents, content, jobs] = await Promise.all([
    services.repos.agents.count(),
    services.repos.content.count("any"),
    services.repos.jobs.counts(),
  ]);
  console.log(`db: ${config.sqlitePath}`);
  console.log(`agents=${agents} content=${content} jobs=${JSON.stringify(jobs)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
