import type { SqlDatabase } from "../db/database";
import { newId, nowIso } from "../db/ids";
import type { Agent, AgentRow, AgentStyle } from "../db/types";

export interface NewAgent {
  handle: string;
  name: string;
  tagline: string;
  bio: string;
  style: AgentStyle;
  systemPrompt: string;
  avatarSeed?: string;
}

export function mapAgent(row: AgentRow): Agent {
  const { style, is_active, ...rest } = row;
  return { ...rest, style: JSON.parse(style) as AgentStyle, isActive: is_active === 1 };
}

export class AgentsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<Agent[]> {
    const rows = await this.db
      .prepare("SELECT * FROM agents WHERE is_active = 1 ORDER BY created_at ASC")
      .all<AgentRow>();
    return rows.map(mapAgent);
  }

  async getById(id: string): Promise<Agent | null> {
    const row = await this.db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<AgentRow>();
    return row ? mapAgent(row) : null;
  }

  async getByHandle(handle: string): Promise<Agent | null> {
    const row = await this.db
      .prepare("SELECT * FROM agents WHERE handle = ?")
      .bind(handle.toLowerCase())
      .first<AgentRow>();
    return row ? mapAgent(row) : null;
  }

  async count(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM agents").first<{ n: number }>();
    return r?.n ?? 0;
  }

  async insert(input: NewAgent): Promise<Agent> {
    const id = newId("agt");
    const ts = nowIso();
    await this.db
      .prepare(
        `INSERT INTO agents (id, handle, name, tagline, bio, style, system_prompt, avatar_seed, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        id,
        input.handle.toLowerCase(),
        input.name,
        input.tagline,
        input.bio,
        JSON.stringify(input.style),
        input.systemPrompt,
        input.avatarSeed ?? input.handle,
        ts,
        ts,
      )
      .run();
    return (await this.getById(id))!;
  }
}
