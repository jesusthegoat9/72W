-- Reconcile content rows before 0003 adds UNIQUE(content.job_id).
--
-- Databases on 0001/0002 could hold two content rows for one job (before
-- leases existed, a reclaimed worker and the original could both insert).
-- Keep job_id on exactly one canonical row per job: the row that
-- generation_jobs.content_id points at, else the earliest created_at, else
-- the lowest id. Every other row keeps its link in legacy_job_id. Nothing is
-- deleted or overwritten. No-op when there are no duplicates, which is why
-- it is safe to run on a database that already applied 0003 (the unique
-- index guarantees there is nothing to reconcile).
--
-- Sorts between 0002_indexes.sql and 0003_leases.sql under both the local
-- runner (plain string sort) and wrangler (numeric prefix, then string).
ALTER TABLE content ADD COLUMN legacy_job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_content_legacy_job ON content(legacy_job_id);

DROP TABLE IF EXISTS _content_job_canonical;
CREATE TABLE _content_job_canonical (job_id TEXT PRIMARY KEY, content_id TEXT NOT NULL);
INSERT INTO _content_job_canonical (job_id, content_id)
SELECT d.job_id,
       COALESCE(
         (SELECT j.content_id FROM generation_jobs j
           WHERE j.id = d.job_id
             AND j.content_id IN (SELECT c.id FROM content c WHERE c.job_id = d.job_id)),
         (SELECT c.id FROM content c WHERE c.job_id = d.job_id ORDER BY c.created_at, c.id LIMIT 1)
       )
FROM (SELECT job_id FROM content WHERE job_id IS NOT NULL GROUP BY job_id HAVING COUNT(*) > 1) d;

UPDATE content
   SET legacy_job_id = job_id, job_id = NULL
 WHERE job_id IN (SELECT job_id FROM _content_job_canonical)
   AND id NOT IN (SELECT content_id FROM _content_job_canonical);

DROP TABLE _content_job_canonical;
