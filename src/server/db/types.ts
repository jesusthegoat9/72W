export type ContentStatus = "draft" | "published" | "archived";
export type ContentSource = "seed" | "generated";
export type JobKind = "text" | "video";
export type JobStatus = "queued" | "processing" | "completed" | "failed";
export type ProviderName = "mock" | "openrouter" | "pruna";

export interface AgentRow {
  id: string;
  handle: string;
  name: string;
  tagline: string;
  bio: string;
  style: string; // JSON
  system_prompt: string;
  avatar_seed: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface AgentStyle {
  voice: string;
  favouriteCategories: string[];
  quirks: string[];
  accent: string; // CSS colour used for avatar/thumb tint
}

export interface Agent extends Omit<AgentRow, "style" | "is_active"> {
  style: AgentStyle;
  isActive: boolean;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  sort_order: number;
  created_at: string;
}
export type Category = CategoryRow;

export interface ContentRow {
  id: string;
  agent_id: string;
  category_id: string;
  job_id: string | null;
  /** Set by migration 0002b on rows that used to share a job_id with another row. */
  legacy_job_id: string | null;
  title: string;
  slug: string;
  description: string;
  tags: string; // JSON
  duration_seconds: number;
  media_key: string | null;
  thumbnail_seed: string;
  status: ContentStatus;
  source: ContentSource;
  views: number;
  likes: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Content extends Omit<ContentRow, "tags"> {
  tags: string[];
}

/** Content joined with the fields the UI needs for a card. */
export interface ContentCard extends Content {
  agent_handle: string;
  agent_name: string;
  agent_accent: string;
  category_slug: string;
  category_name: string;
}

export interface JobRow {
  id: string;
  agent_id: string;
  kind: JobKind;
  status: JobStatus;
  idempotency_key: string;
  prompt: string;
  params: string; // JSON
  provider: ProviderName;
  provider_ref: string | null;
  dry_run: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: string | null; // JSON
  content_id: string | null;
  next_attempt_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** Dispatcher currently holding the job, and when its lease lapses unless renewed. */
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobParams {
  categorySlug?: string;
  model?: string;
  resolution?: "720p" | "1080p";
  draft?: boolean;
  durationSeconds?: number;
  [key: string]: unknown;
}

export interface Job extends Omit<JobRow, "params" | "result" | "dry_run"> {
  params: JobParams;
  result: Record<string, unknown> | null;
  dryRun: boolean;
}

export interface ActivityRow {
  id: string;
  agent_id: string | null;
  job_id: string | null;
  content_id: string | null;
  type: string;
  message: string;
  meta: string;
  simulated: number;
  created_at: string;
}
export interface Activity extends Omit<ActivityRow, "meta" | "simulated"> {
  meta: Record<string, unknown>;
  simulated: boolean;
}
