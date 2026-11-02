import type { SqlDatabase, SqlStatement, SqlValue } from "../db/database";
import { newId, nowIso } from "../db/ids";
import type { Activity, ActivityRow } from "../db/types";
import { LEASE_FENCE_SQL, LeaseLostError, leaseFenceParams, type LeaseFence } from "./lease";

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

/** Event types the public feed may show; everything else is operational and stays private. */
export const PUBLIC_ACTIVITY_TYPES = ["content.published", "job.queued", "job.completed"] as const;
export type PublicActivityType = (typeof PUBLIC_ACTIVITY_TYPES)[number];

export interface PublicActivity {
  id: string;
  type: string;
  created_at: string;
  message: string;
  contentSlug: string | null;
  agentHandle: string;
  agentName: string;
  agentAccent: string;
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

  /**
   * Builds the insert statement for an entry. With `fence` the insert only
   * happens while that job lease is held (same statement, atomic), so a
   * worker that lost its job cannot log outcomes it did not own. Returned
   * unexecuted so it can also ride inside a `batch`.
   */
  statement(input: NewActivity, fence?: LeaseFence): { id: string; statement: SqlStatement } {
    const id = newId("act");
    const values: SqlValue[] = [
      id,
      input.agentId ?? null,
      input.jobId ?? null,
      input.contentId ?? null,
      input.type,
      input.message,
      JSON.stringify(input.meta ?? {}),
      input.simulated === false ? 0 : 1,
      input.createdAt ?? nowIso(),
    ];
    const columns = "(id, agent_id, job_id, content_id, type, message, meta, simulated, created_at)";
    const sql = fence
      ? `INSERT INTO activity_log ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${LEASE_FENCE_SQL}`
      : `INSERT INTO activity_log ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    if (fence) values.push(...leaseFenceParams(fence));
    return { id, statement: this.db.prepare(sql).bind(...values) };
  }

  async log(input: NewActivity): Promise<Activity> {
    const { id, statement } = this.statement(input);
    await statement.run();
    const row = await this.db.prepare("SELECT * FROM activity_log WHERE id = ?").bind(id).first<ActivityRow>();
    return mapActivity(row!);
  }

  /** Fenced log: throws LeaseLostError (and writes nothing) if the lease is no longer held. */
  async logOwned(input: NewActivity, fence: LeaseFence): Promise<Activity> {
    const { id, statement } = this.statement(input, fence);
    const { changes } = await statement.run();
    if (changes !== 1) throw new LeaseLostError(fence.jobId, fence.owner, "fenced activity write refused");
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
  /**
   * The sanitised feed shown on the site: publications of still-published
   * content plus bare "queued / finished a job" lines, regenerated from the
   * event type so no stored message, draft title, media key or error text can
   * leak. Across all agents when `agentId` is omitted (the home page shift
   * log), or one agent's own lines. `types` narrows to a subset of the public
   * types; it can never widen past them.
   */
  async publicRecent(opts: { agentId?: string; limit?: number; types?: readonly PublicActivityType[] } = {}): Promise<PublicActivity[]> {
    const params: SqlValue[] = [];
    let scope = "";
    if (opts.agentId) {
      scope = "a.agent_id = ? AND ";
      params.push(opts.agentId);
    }
    const types = (opts.types ?? PUBLIC_ACTIVITY_TYPES).filter((t) => (PUBLIC_ACTIVITY_TYPES as readonly string[]).includes(t));
    if (types.length === 0) return [];
    const jobTypes = types.filter((t) => t !== "content.published");
    const clauses: string[] = [];
    if (types.includes("content.published")) clauses.push("(a.type = 'content.published' AND c.status = 'published')");
    if (jobTypes.length) {
      clauses.push(`a.type IN (${jobTypes.map(() => "?").join(", ")})`);
      params.push(...jobTypes);
    }
    params.push(Math.min(opts.limit ?? 10, 50));
    const rows = await this.db
      .prepare(
        `SELECT a.id, a.type, a.created_at, g.handle AS agent_handle, g.name AS agent_name, g.style AS agent_style,
                c.title AS content_title, c.slug AS content_slug
         FROM activity_log a
         JOIN agents g ON g.id = a.agent_id
         LEFT JOIN content c ON c.id = a.content_id
         WHERE ${scope}(${clauses.join(" OR ")})
         ORDER BY a.created_at DESC, (a.type = 'content.published') DESC, a.id DESC LIMIT ?`,
      )
      .bind(...params)
      .all<{
        id: string;
        type: string;
        created_at: string;
        agent_handle: string;
        agent_name: string;
        agent_style: string;
        content_title: string | null;
        content_slug: string | null;
      }>();
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      created_at: r.created_at,
      message: publicActivityMessage(r.type, r.content_title),
      contentSlug: r.type === "content.published" ? r.content_slug : null,
      agentHandle: r.agent_handle,
      agentName: r.agent_name,
      agentAccent: (JSON.parse(r.agent_style) as { accent?: string }).accent ?? "#7cf",
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
