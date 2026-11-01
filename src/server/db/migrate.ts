import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SqlDatabase } from "./database";

/**
 * Applies SQL files from /migrations in filename order, recording each in
 * `_migrations`. Used locally and in tests. On Cloudflare the same folder is
 * applied with `wrangler d1 migrations apply` (which keeps its own
 * `d1_migrations` table and wraps each file in its own transaction), so this
 * runner is never used against D1. Migration files must therefore stay
 * plain SQL: no PRAGMA foreign_keys toggles, no BEGIN/COMMIT of their own.
 */
export async function migrate(db: SqlDatabase, dir = path.join(process.cwd(), "migrations")) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (await db.prepare("SELECT name FROM _migrations").all<{ name: string }>()).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    // One transaction per file: a failing migration leaves nothing half-applied.
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db
        .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
        .bind(file, new Date().toISOString())
        .run();
      await db.exec("COMMIT");
    } catch (err) {
      await db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed and was rolled back: ${(err as Error).message}`);
    }
    ran.push(file);
  }
  return ran;
}
