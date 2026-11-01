/**
 * Local database maintenance.
 *   npm run db:migrate   apply pending migrations to .data/x86xx.db (and seed if empty)
 *   npm run db:seed      alias of migrate
 *   npm run db:reset     delete the local db + media and rebuild from scratch
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/server/config";
import { createServices } from "../src/server/container";

async function main() {
  const cmd = process.argv[2] ?? "migrate";
  const config = loadConfig();

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
