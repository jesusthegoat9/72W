-- Worker leases for generation jobs, and at most one content row per job.
-- Additive: existing rows get NULL leases, which the dispatcher treats as expired.
ALTER TABLE generation_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE generation_jobs ADD COLUMN lease_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON generation_jobs(status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_job ON content(job_id) WHERE job_id IS NOT NULL;
