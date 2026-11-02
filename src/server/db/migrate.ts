import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SqlDatabase } from "./database";

export interface DuplicateJobContent {
  job_id: string;
  n: number;
  ids: string;
}

/** Jobs that have more than one content row: the state migration 0002b reconciles and 0003 forbids. */
export async function findDuplicateJobContent(db: SqlDatabase, limit = 20): Promise<DuplicateJobContent[]> {
  return db
    .prepare(
      `SELECT job_id, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM content WHERE job_id IS NOT NULL
       GROUP BY job_id HAVING COUNT(*) > 1 ORDER BY job_id LIMIT ?`,
    )
    .bind(limit)
    .all<DuplicateJobContent>();
}

/**
 * Checks run before a specific migration file, so a database that cannot
 * take it fails with an actionable message instead of a bare constraint
 * error. Keyed by file name.
 */
const PREFLIGHT: Record<string, (db: SqlDatabase) => Promise<void>> = {
  "0003_leases.sql": async (db) => {
    const dupes = await findDuplicateJobContent(db, 5);
    if (dupes.length === 0) return;
    const sample = dupes.map((d) => `${d.job_id} -> ${d.ids}`).join("; ");
    throw new Error(
      `0003_leases.sql adds UNIQUE(content.job_id) but ${dupes.length}${dupes.length === 5 ? "+" : ""} job(s) still have more than one content row (${sample}). ` +
        `migrations/0002b_reconcile_content_jobs.sql must be present and sort before 0003: it moves the extra rows' job_id into legacy_job_id without deleting anything. ` +
        `If you have already created legacy_job_id by hand, move the duplicates yourself (UPDATE content SET legacy_job_id = job_id, job_id = NULL WHERE id IN (...)) and rerun.`,
    );
  },
};

/** Names of migration files in `dir` not yet recorded in `_migrations`. Read-only: works on a read-only connection and on a database with no tables. */
export async function pendingMigrations(db: SqlDatabase, dir = path.join(process.cwd(), "migrations")): Promise<string[]> {
  const hasTable = await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").first();
  const applied = new Set(hasTable ? (await db.prepare("SELECT name FROM _migrations").all<{ name: string }>()).map((r) => r.name) : []);
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort().filter((f) => !applied.has(f));
}

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
    await PREFLIGHT[file]?.(db);
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
      const message = (err as Error).message;
      const unique = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(message);
      const hint = unique
        ? ` Existing rows violate the new unique index on ${unique[1]}.${unique[2]}; inspect them with: SELECT ${unique[2]}, COUNT(*) FROM ${unique[1]} WHERE ${unique[2]} IS NOT NULL GROUP BY ${unique[2]} HAVING COUNT(*) > 1. Nothing was changed.`
        : /duplicate column name/i.test(message)
          ? " The column already exists (added by hand?). Record the migration as applied only if the rest of the file has also been applied."
          : "";
      throw new Error(`migration ${file} failed and was rolled back: ${message}.${hint}`);
    }
    ran.push(file);
  }
  return ran;
}
