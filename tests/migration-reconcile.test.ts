import { describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "@/server/db/sqlite";
import { findDuplicateJobContent, migrate, pendingMigrations } from "@/server/db/migrate";
import { createRepos } from "@/server/repos";
import { seedCatalogue } from "@/server/seed";

/**
 * FINDING 3: migrations/0003_leases.sql adds `UNIQUE INDEX uq_content_job ON
 * content(job_id) WHERE job_id IS NOT NULL`, but databases created on 0001/0002
 * could legitimately hold two content rows for one job (a reclaimed worker and
 * the original both inserting). On such a database migrate() -- which
 * container.ts runs on every boot -- throws
 *   "migration 0003_leases.sql failed and was rolled back: UNIQUE constraint failed: content.job_id"
 * and the app never starts.
 *
 * These tests describe the DESIRED behaviour (a reconcile migration that sorts
 * between 0002 and 0003 plus a `content.legacy_job_id` column) and therefore
 * FAIL against the current code.
 */

const MIGRATIONS = path.join(process.cwd(), "migrations");

/** Wrangler's ordering rule for d1 migration names (workers-utils compareSegments). */
function wranglerCompare(a: string, b: string): number {
  const num = (s: string) => parseInt(s.split("_")[0], 10);
  const an = num(a);
  const bn = num(b);
  if (an !== bn) {
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    if (Number.isFinite(an)) return -1;
    if (Number.isFinite(bn)) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Builds a database exactly as a deployment that ran only the given migration files would have. */
async function legacyDatabase(files: string[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x86xx-legacy-"));
  for (const f of files) await copyFile(path.join(MIGRATIONS, f), path.join(dir, f));
  const db = new SqliteDatabase(":memory:");
  expect(await migrate(db, dir)).toEqual(files);
  const repos = createRepos(db);
  await seedCatalogue(repos, { now: new Date("2026-10-01T00:00:00Z") });
  return { db, repos };
}

type ContentRow = { id: string; job_id: string | null; legacy_job_id?: string | null; created_at: string };

describe("finding 3: upgrading a pre-0003 database that holds two content rows for one job", () => {
  it("migrates, keeps both rows, keeps job_id on the canonical row and moves the other link to legacy_job_id", async () => {
    const { db, repos } = await legacyDatabase(["0001_init.sql", "0002_indexes.sql"]);
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("hot-racks"))!;

    // A job that completed on the old schema.
    const jobId = "job_legacy_dup";
    await db
      .prepare(
        `INSERT INTO generation_jobs (id, agent_id, kind, status, idempotency_key, prompt, provider, dry_run, attempts, created_at, updated_at)
         VALUES (?, ?, 'text', 'completed', 'legacy-dup', 'p', 'mock', 1, 2, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`,
      )
      .bind(jobId, agent.id)
      .run();

    // Two content rows for that job. The EARLIER one is the orphan (a reclaimed
    // worker's late insert that nothing points at); the LATER one is the row
    // generation_jobs.content_id references, so it must be the canonical one.
    const insertContent = (id: string, createdAt: string) =>
      db
        .prepare(
          `INSERT INTO content (id, agent_id, category_id, job_id, title, slug, description, tags, duration_seconds,
             media_key, thumbnail_seed, status, source, views, likes, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '', '[]', 0, NULL, ?, 'draft', 'generated', 0, 0, NULL, ?, ?)`,
        )
        .bind(id, agent.id, cat.id, jobId, `Dup ${id}`, `dup-${id}`, id, createdAt, createdAt)
        .run();
    await insertContent("vid_orphan", "2026-10-02T00:00:01Z");
    await insertContent("vid_canonical", "2026-10-02T00:00:05Z");
    await db.prepare("UPDATE generation_jobs SET content_id = ? WHERE id = ?").bind("vid_canonical", jobId).run();

    const totalBefore = await repos.content.count("any");

    // Boot: container.ts calls migrate(db) with the real migrations folder.
    const ran = await migrate(db, MIGRATIONS); // same as container.ts default; currently throws: UNIQUE constraint failed: content.job_id
    expect(ran).toContain("0003_leases.sql");
    expect((await db.prepare("SELECT name FROM _migrations ORDER BY name").all<{ name: string }>()).map((r) => r.name)).toContain(
      "0003_leases.sql",
    );

    // Both rows survive.
    expect(await repos.content.count("any")).toBe(totalBefore);
    const rows = Object.fromEntries(
      (await db.prepare("SELECT * FROM content WHERE id IN ('vid_orphan','vid_canonical')").all<ContentRow>()).map((r) => [r.id, r]),
    );
    expect(Object.keys(rows).sort()).toEqual(["vid_canonical", "vid_orphan"]);

    // The row the job points at keeps job_id; the other keeps its link in legacy_job_id.
    expect(rows.vid_canonical.job_id).toBe(jobId);
    expect(rows.vid_canonical.legacy_job_id ?? null).toBeNull();
    expect(rows.vid_orphan.job_id).toBeNull();
    expect(rows.vid_orphan.legacy_job_id).toBe(jobId);

    // The relationship is still navigable from the job and the unique index is in place.
    expect((await repos.content.getByJobId(jobId))?.id).toBe("vid_canonical");
    expect((await db.prepare("SELECT content_id FROM generation_jobs WHERE id = ?").bind(jobId).first<{ content_id: string }>())?.content_id).toBe("vid_canonical");
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all<{ name: string }>()).map((i) => i.name);
    expect(indexes).toContain("uq_content_job");

    // Rerun is a no-op.
    expect(await migrate(db, MIGRATIONS)).toEqual([]);
  });

  it("the reconcile migration sorts between 0002 and 0003 under both the local runner and wrangler d1", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql"));
    const local = [...files].sort(); // src/server/db/migrate.ts: readdir().sort()
    const d1 = [...files].sort(wranglerCompare); // wrangler d1 migrations apply
    expect(d1).toEqual(local);
    const i2 = local.indexOf("0002_indexes.sql");
    const i3 = local.indexOf("0003_leases.sql");
    expect(i3 - i2).toBeGreaterThan(1); // at least one file (the reconcile step) sits between them
  });

  it("a database that already applied 0003 (founder's local db, D1 emulator) still boots and gains legacy_job_id", async () => {
    const { db } = await legacyDatabase(["0001_init.sql", "0002_indexes.sql", "0003_leases.sql"]);
    await expect(migrate(db, MIGRATIONS)).resolves.not.toThrow();
    const cols = (await db.prepare("PRAGMA table_info(content)").all<{ name: string }>()).map((c) => c.name);
    expect(cols).toContain("legacy_job_id");
    expect(await migrate(db, MIGRATIONS)).toEqual([]);
  });

  async function legacyWithDuplicates(opts: { referenced?: "first" | "second" | "none"; rows?: number } = {}) {
    const { db, repos } = await legacyDatabase(["0001_init.sql", "0002_indexes.sql"]);
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("hot-racks"))!;
    const jobId = "job_dup";
    await db
      .prepare(
        `INSERT INTO generation_jobs (id, agent_id, kind, status, idempotency_key, prompt, provider, dry_run, attempts, created_at, updated_at)
         VALUES (?, ?, 'text', 'completed', 'dup', 'p', 'mock', 1, 2, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`,
      )
      .bind(jobId, agent.id)
      .run();
    const ids: string[] = [];
    for (let i = 0; i < (opts.rows ?? 2); i++) {
      const id = `vid_dup_${i}`;
      ids.push(id);
      await db
        .prepare(
          `INSERT INTO content (id, agent_id, category_id, job_id, title, slug, description, tags, duration_seconds, media_key, thumbnail_seed, status, source, views, likes, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '', '[]', 0, NULL, ?, 'published', 'generated', 0, 0, NULL, ?, ?)`,
        )
        .bind(id, agent.id, cat.id, jobId, `Dup ${i}`, `dup-${i}`, id, `2026-10-02T00:00:0${i}Z`, `2026-10-02T00:00:0${i}Z`)
        .run();
    }
    const referenced = opts.referenced === "second" ? ids[1] : opts.referenced === "first" ? ids[0] : null;
    if (referenced) await db.prepare("UPDATE generation_jobs SET content_id = ? WHERE id = ?").bind(referenced, jobId).run();
    return { db, repos, jobId, ids };
  }

  it("a clean database applies every migration in order", async () => {
    const db = new SqliteDatabase(":memory:");
    expect(await migrate(db, MIGRATIONS)).toEqual(["0001_init.sql", "0002_indexes.sql", "0002b_reconcile_content_jobs.sql", "0003_leases.sql"]);
    expect(await pendingMigrations(db, MIGRATIONS)).toEqual([]);
  });

  it("when the job points at no row, the earliest row keeps job_id", async () => {
    const { db, repos, jobId, ids } = await legacyWithDuplicates({ referenced: "none" });
    await migrate(db, MIGRATIONS);
    expect((await repos.content.getByJobId(jobId))!.id).toBe(ids[0]);
    expect((await repos.content.legacyForJob(jobId)).map((c) => c.id)).toEqual([ids[1]]);
    expect(await repos.content.count("any")).toBeGreaterThanOrEqual(2);
    expect(await findDuplicateJobContent(db)).toEqual([]);
  });

  it("with three rows the referenced one wins and the other two are parked", async () => {
    const { db, repos, jobId, ids } = await legacyWithDuplicates({ referenced: "second", rows: 3 });
    await migrate(db, MIGRATIONS);
    expect((await repos.content.getByJobId(jobId))!.id).toBe(ids[1]);
    expect((await repos.content.legacyForJob(jobId)).map((c) => c.id).sort()).toEqual([ids[0], ids[2]].sort());
    // Parked rows stay published and visible; only their job link moved.
    const parked = await repos.content.getById(ids[0]);
    expect(parked).toMatchObject({ status: "published", job_id: null, legacy_job_id: jobId });
  });

  it("rollback: if the reconcile file itself fails, nothing is recorded and the error says why", async () => {
    const { db, repos, jobId } = await legacyWithDuplicates({ referenced: "first" });
    // Someone added the column by hand earlier: ALTER TABLE in 0002b now fails.
    await db.exec("ALTER TABLE content ADD COLUMN legacy_job_id TEXT");
    await expect(migrate(db, MIGRATIONS)).rejects.toThrow(/0002b_reconcile_content_jobs.sql failed and was rolled back: duplicate column name.*column already exists/);
    expect((await db.prepare("SELECT name FROM _migrations ORDER BY name").all<{ name: string }>()).map((r) => r.name)).toEqual(["0001_init.sql", "0002_indexes.sql"]);
    expect((await findDuplicateJobContent(db)).map((d) => d.job_id)).toEqual([jobId]);
    expect(await repos.content.count("any")).toBeGreaterThanOrEqual(2);
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_content_job_canonical'").all()).length).toBe(0);
  });

  it("preflight: duplicates with the reconcile step missing fail with an actionable message, not a bare constraint error", async () => {
    const { db, repos, jobId } = await legacyWithDuplicates({ referenced: "first" });
    const dir = await mkdtemp(path.join(os.tmpdir(), "x86xx-no-reconcile-"));
    for (const f of ["0001_init.sql", "0002_indexes.sql", "0003_leases.sql"]) await copyFile(path.join(MIGRATIONS, f), path.join(dir, f));
    await expect(migrate(db, dir)).rejects.toThrow(/0003_leases.sql adds UNIQUE\(content.job_id\) but 1 job\(s\) still have more than one content row \(job_dup -> vid_dup_0,vid_dup_1\).*0002b_reconcile_content_jobs.sql must be present/);
    expect((await db.prepare("SELECT name FROM _migrations ORDER BY name").all<{ name: string }>()).map((r) => r.name)).toEqual(["0001_init.sql", "0002_indexes.sql"]);
    expect((await findDuplicateJobContent(db)).map((d) => d.job_id)).toEqual([jobId]);
    expect(await repos.content.count("any")).toBeGreaterThanOrEqual(2);
    // Add the reconcile file and the same database upgrades.
    await copyFile(path.join(MIGRATIONS, "0002b_reconcile_content_jobs.sql"), path.join(dir, "0002b_reconcile_content_jobs.sql"));
    expect(await migrate(db, dir)).toEqual(["0002b_reconcile_content_jobs.sql", "0003_leases.sql"]);
    expect(await migrate(db, dir)).toEqual([]);
  });

  it("the generic failure hint names the violated unique index", async () => {
    const db = new SqliteDatabase(":memory:");
    const dir = await mkdtemp(path.join(os.tmpdir(), "x86xx-hint-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "0001_t.sql"), "CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('a'); INSERT INTO t VALUES ('a');");
    await writeFile(path.join(dir, "0002_u.sql"), "CREATE UNIQUE INDEX u ON t(k);");
    await expect(migrate(db, dir)).rejects.toThrow(/0002_u.sql failed and was rolled back: UNIQUE constraint failed: t.k.*inspect them with: SELECT k, COUNT\(\*\) FROM t WHERE k IS NOT NULL GROUP BY k HAVING COUNT\(\*\) > 1/);
  });
});
