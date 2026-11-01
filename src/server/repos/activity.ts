import type { SqlDatabase, SqlValue } from "../db/database";
import { newId, nowIso } from "../db/ids";
import type { Activity, ActivityRow } from "../db/types";

export interface NewActivity {
  type: string;
  message: string;
  agentId?: string | null;
  jobId?: string | null;
  contentId?: string | null;
  meta?: Record<string, unknown>;
  simulated?: boolean;
  createdAt?: string;
}

export interface PublicActivity {
  id: string;
  type: string;
  created_at: string;
  message: string;
  contentSlug: string | null;
}

export function publicActivityMessage(type: string, contentTitle: string | null): string {
  switch (type) {
    case "content.published":
      return contentTitle ? `Published "${contentTitle}"` : "Published a video";
    case "job.queued":
      return "Queued a generation job";
    case "job.completed":
      return "Finished a generation job";
    default:
      return "Did something with hardware";
  }
}

export function mapActivity(row: ActivityRow): Activity {
  const { meta, simulated, ...rest } = row;
  return { ...rest, meta: JSON.parse(meta) as Record<string, unknown>, simulated: simulated === 1 };
}

export class ActivityRepo {
  constructor(private readonly db: SqlDatabase) {}

  async log(input: NewActivity): Promise<Activity> {
    const id = newId("act");
    await this.db
      .prepare(
        `INSERT INTO activity_log (id, agent_id, job_id, content_id, type, message, meta, simulated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.agentId ?? null,
        input.jobId ?? null,
        input.contentId ?? null,
        input.type,
        input.message,
        JSON.stringify(input.meta ?? {}),
        input.simulated === false ? 0 : 1,
        input.createdAt ?? nowIso(),
      )
      .run();
    const row = await this.db.prepare("SELECT * FROM activity_log WHERE id = ?").bind(id).first<ActivityRow>();
    return mapActivity(row!);
  }

  /** Full trail for one job (operator use). */
  async forJob(jobId: string, limit = 200): Promise<Activity[]> {
    const rows = await this.db
      .prepare("SELECT * FROM activity_log WHERE job_id = ? ORDER BY created_at DESC LIMIT ?")
      .bind(jobId, Math.min(limit, 500))
      .all<ActivityRow>();
    return rows.map(mapActivity);
  }

  /**
   * The public view of an agent's activity. Only events that reveal nothing
   * private: publications of content that is still published (with its
   * title, which is public anyway) and bare job queued/completed events.
   * Failures, retries, drafts, media keys and error text never appear here;
   * messages are regenerated from the type, not read from the row.
   */
  async publicRecent(opts: { agentId: string; limit?: number }): Promise<PublicActivity[]> {
    const rows = await this.db
      .prepare(
        `SELECT a.id, a.type, a.created_at, c.title AS content_title, c.slug AS content_slug
         FROM activity_log a
         LEFT JOIN content c ON c.id = a.content_id
         WHERE a.agent_id = ?
           AND ((a.type = 'content.published' AND c.status = 'published') OR a.type IN ('job.queued', 'job.completed'))
         ORDER BY a.created_at DESC LIMIT ?`,
      )
      .bind(opts.agentId, Math.min(opts.limit ?? 10, 50))
      .all<{ id: string; type: string; created_at: string; content_title: string | null; content_slug: string | null }>();
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      created_at: r.created_at,
      message: publicActivityMessage(r.type, r.content_title),
      contentSlug: r.type === "content.published" ? r.content_slug : null,
    }));
  }

  async recent(opts: { limit?: number; agentId?: string } = {}): Promise<Activity[]> {
    const params: SqlValue[] = [];
    let where = "";
    if (opts.agentId) {
      where = " WHERE agent_id = ?";
      params.push(opts.agentId);
    }
    params.push(Math.min(opts.limit ?? 30, 200));
    const rows = await this.db
      .prepare(`SELECT * FROM activity_log${where} ORDER BY created_at DESC LIMIT ?`)
      .bind(...params)
      .all<ActivityRow>();
    return rows.map(mapActivity);
  }
}
