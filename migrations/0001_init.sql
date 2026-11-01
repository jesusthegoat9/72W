-- x86xx initial schema. D1 (SQLite) compatible.
-- Timestamps are ISO-8601 UTC strings. IDs are prefixed random strings.

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  tagline       TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  style         TEXT NOT NULL DEFAULT '{}',   -- JSON: voice, favourite categories, quirks
  system_prompt TEXT NOT NULL DEFAULT '',
  avatar_seed   TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  category_id      TEXT NOT NULL REFERENCES categories(id),
  job_id           TEXT,                          -- set when produced by a generation job
  title            TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]',    -- JSON array of strings
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  media_key        TEXT,                          -- key in media storage (R2 / local). NULL = placeholder only
  thumbnail_seed   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft'  CHECK (status IN ('draft','published','archived')),
  source           TEXT NOT NULL DEFAULT 'seed'   CHECK (source IN ('seed','generated')),
  views            INTEGER NOT NULL DEFAULT 0,
  likes            INTEGER NOT NULL DEFAULT 0,
  published_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_agent     ON content(agent_id);
CREATE INDEX IF NOT EXISTS idx_content_category  ON content(category_id);
CREATE INDEX IF NOT EXISTS idx_content_status    ON content(status, published_at);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  kind            TEXT NOT NULL CHECK (kind IN ('text','video')),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  prompt          TEXT NOT NULL,
  params          TEXT NOT NULL DEFAULT '{}',    -- JSON: category, model, resolution, draft, ...
  provider        TEXT NOT NULL,                 -- 'mock' | 'openrouter' | 'pruna'
  provider_ref    TEXT,                          -- remote job / prediction id
  dry_run         INTEGER NOT NULL DEFAULT 1,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_error      TEXT,
  result          TEXT,                          -- JSON output summary
  content_id      TEXT REFERENCES content(id),
  next_attempt_at TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON generation_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_agent   ON generation_jobs(agent_id, created_at);

CREATE TABLE IF NOT EXISTS activity_log (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT REFERENCES agents(id),
  job_id     TEXT REFERENCES generation_jobs(id),
  content_id TEXT REFERENCES content(id),
  type       TEXT NOT NULL,                      -- 'job.queued' | 'job.started' | 'job.completed' | 'job.failed' | 'content.published' | ...
  message    TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  simulated  INTEGER NOT NULL DEFAULT 1,         -- 1 = produced by seed/mock providers
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_agent   ON activity_log(agent_id, created_at);
