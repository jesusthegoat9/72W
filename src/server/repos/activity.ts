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
