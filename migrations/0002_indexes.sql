-- Indexes for lookups added since 0001. Additive and idempotent.
CREATE INDEX IF NOT EXISTS idx_content_media_key   ON content(media_key);
CREATE INDEX IF NOT EXISTS idx_activity_job        ON activity_log(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_content    ON activity_log(content_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_processing     ON generation_jobs(status, started_at);
