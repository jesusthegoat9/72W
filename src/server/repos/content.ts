import type { SqlDatabase, SqlStatement, SqlValue } from "../db/database";
import { newId, nowIso, slugify } from "../db/ids";
import type { Content, ContentCard, ContentRow, ContentSource, ContentStatus } from "../db/types";
import { LEASE_FENCE_SQL, LeaseLostError, leaseFenceParams, type LeaseFence } from "./lease";

export interface NewContent {
  agentId: string;
  categoryId: string;
  title: string;
  description: string;
  tags?: string[];
  durationSeconds?: number;
  mediaKey?: string | null;
  thumbnailSeed?: string;
  status?: ContentStatus;
  source?: ContentSource;
  jobId?: string | null;
  views?: number;
  likes?: number;
  publishedAt?: string | null;
  createdAt?: string;
}

export type ContentSort = "trending" | "newest" | "views";

export interface ContentQuery {
  q?: string;
  categorySlug?: string;
  agentId?: string;
  status?: ContentStatus | "any";
  sort?: ContentSort;
  limit?: number;
  offset?: number;
}

type CardRow = ContentRow & {
  agent_handle: string;
  agent_name: string;
  agent_style: string;
  category_slug: string;
  category_name: string;
};

const CARD_SELECT = `
  SELECT c.*, a.handle AS agent_handle, a.name AS agent_name, a.style AS agent_style,
         k.slug AS category_slug, k.name AS category_name
  FROM content c
  JOIN agents a ON a.id = c.agent_id
  JOIN categories k ON k.id = c.category_id`;

export function mapContent(row: ContentRow): Content {
  return { ...row, tags: JSON.parse(row.tags) as string[] };
}

function mapCard(row: CardRow): ContentCard {
  const { agent_style, tags, ...rest } = row;
  const accent = (JSON.parse(agent_style) as { accent?: string }).accent ?? "#7cf";
  return { ...rest, tags: JSON.parse(tags) as string[], agent_accent: accent };
}

export class ContentRepo {
  constructor(private readonly db: SqlDatabase) {}

  /** The content row produced by a job, if any. One job yields at most one row. */
  async getByJobId(jobId: string): Promise<Content | null> {
    const row = await this.db.prepare("SELECT * FROM content WHERE job_id = ?").bind(jobId).first<ContentRow>();
    return row ? mapContent(row) : null;
  }

  /** Rows that lost their job_id to a canonical row in migration 0002b. */
  async legacyForJob(jobId: string): Promise<Content[]> {
    const rows = await this.db.prepare("SELECT * FROM content WHERE legacy_job_id = ? ORDER BY created_at").bind(jobId).all<ContentRow>();
    return rows.map(mapContent);
  }

  /**
   * The job's content row, readable only while `owner` holds the lease.
   * Null when there is no row yet; LeaseLostError when the lease is gone.
   */
  async getByJobIdOwned(fence: LeaseFence): Promise<Content | null> {
    const row = await this.db
      .prepare(`SELECT c.* FROM content c WHERE c.job_id = ? AND ${LEASE_FENCE_SQL}`)
      .bind(fence.jobId, ...leaseFenceParams(fence))
      .first<ContentRow>();
    if (row) return mapContent(row);
    if (!(await this.db.prepare(`SELECT 1 AS ok WHERE ${LEASE_FENCE_SQL}`).bind(...leaseFenceParams(fence)).first())) {
      throw new LeaseLostError(fence.jobId, fence.owner, "fenced content read refused");
    }
    return null;
  }

  /**
   * Inserts content. When `jobId` is set the insert is idempotent per job:
   * if a row for that job already exists (another worker got there first)
   * it is returned instead, guaranteed by the unique index on job_id.
   * Unfenced: for seeds, tests and operators. Workers use insertForJob.
   */
  async insert(input: NewContent): Promise<Content> {
    if (input.jobId) {
      const existing = await this.getByJobId(input.jobId);
      if (existing) return existing;
    }
    const written = await this.write(input, null);
    if (!written) throw new Error("content insert affected no rows");
    return written.content;
  }

  /**
   * Worker-side insert for a job's content. The INSERT carries the lease
   * fence in the same statement, so a worker that lost the job cannot
   * persist (let alone publish) a row, however late its provider call
   * returns. If a previous holder of the lease already produced the row,
   * that row is adopted (created: false), but only by the current owner.
   */
  async insertForJob(input: NewContent & { jobId: string }, fence: LeaseFence): Promise<{ content: Content; created: boolean }> {
    const existing = await this.getByJobIdOwned(fence);
    if (existing) return { content: existing, created: false };
    const written = await this.write(input, fence);
    if (written) return written;
    // Zero rows without an error: the fence failed inside the statement.
    throw new LeaseLostError(fence.jobId, fence.owner, "fenced content insert refused");
  }

  /**
   * Statement that publishes a draft, fenced on the job lease, for use in
   * the completion batch: the row goes public in the same transaction that
   * completes the job, never before.
   */
  publishStatement(contentId: string, nowIsoString: string, fence: LeaseFence): SqlStatement {
    return this.db
      .prepare(
        `UPDATE content SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
         WHERE id = ? AND status = 'draft' AND ${LEASE_FENCE_SQL}`,
      )
      .bind(nowIsoString, nowIsoString, contentId, ...leaseFenceParams(fence));
  }

  private async write(input: NewContent, fence: LeaseFence | null): Promise<{ content: Content; created: boolean } | null> {
    const id = newId("vid");
    const ts = input.createdAt ?? nowIso();
    const status = input.status ?? "draft";
    const base = slugify(input.title) || id;
    const columns = `(id, agent_id, category_id, job_id, title, slug, description, tags, duration_seconds,
               media_key, thumbnail_seed, status, source, views, likes, published_at, created_at, updated_at)`;
    // Concurrent inserts can pick the same free slug; the UNIQUE index catches
    // the losers, which retry with the next free suffix (one winner per round).
    for (let attempt = 0; attempt < 25; attempt++) {
      const slug = await this.uniqueSlug(base);
      const values: SqlValue[] = [
        id,
        input.agentId,
        input.categoryId,
        input.jobId ?? null,
        input.title,
        slug,
        input.description,
        JSON.stringify(input.tags ?? []),
        input.durationSeconds ?? 0,
        input.mediaKey ?? null,
        input.thumbnailSeed ?? id,
        status,
        input.source ?? "seed",
        input.views ?? 0,
        input.likes ?? 0,
        input.publishedAt ?? (status === "published" ? ts : null),
        ts,
        ts,
      ];
      const sql = fence
        ? `INSERT INTO content ${columns} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${LEASE_FENCE_SQL}`
        : `INSERT INTO content ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      if (fence) values.push(...leaseFenceParams(fence));
      try {
        const { changes } = await this.db.prepare(sql).bind(...values).run();
        if (changes === 0) return null;
        return { content: (await this.getById(id))!, created: true };
      } catch (err) {
        const text = String(err);
        if (input.jobId && /content\.job_id|uq_content_job/i.test(text)) {
          // A row for this job appeared under us. It was written by whoever
          // held the lease at that moment, so adopt it only if that is still us.
          const raced = fence ? await this.getByJobIdOwned(fence) : await this.getByJobId(input.jobId);
          if (raced) return { content: raced, created: false };
          if (fence) throw new LeaseLostError(fence.jobId, fence.owner, "content row written by another lease holder");
        }
        if (!/UNIQUE.*slug|content\.slug/i.test(text)) throw err;
      }
    }
    throw new Error(`could not allocate a unique slug for "${input.title}"`);
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base;
    for (let i = 2; ; i++) {
      const hit = await this.db.prepare("SELECT 1 FROM content WHERE slug = ?").bind(slug).first();
      if (!hit) return slug;
      slug = `${base}-${i}`;
    }
  }

  async getById(id: string): Promise<Content | null> {
    const row = await this.db.prepare("SELECT * FROM content WHERE id = ?").bind(id).first<ContentRow>();
    return row ? mapContent(row) : null;
  }

  async getCard(idOrSlug: string): Promise<ContentCard | null> {
    const row = await this.db
      .prepare(`${CARD_SELECT} WHERE c.id = ? OR c.slug = ?`)
      .bind(idOrSlug, idOrSlug)
      .first<CardRow>();
    return row ? mapCard(row) : null;
  }

  /** WHERE clause shared by `query` and `countMatching`, so a page count always matches its pages. */
  private whereFor(q: ContentQuery): { where: string; params: SqlValue[]; term: string | undefined } {
    const where: string[] = [];
    const params: SqlValue[] = [];
    const status = q.status ?? "published";
    if (status !== "any") {
      where.push("c.status = ?");
      params.push(status);
    }
    if (q.categorySlug) {
      where.push("k.slug = ?");
      params.push(q.categorySlug);
    }
    if (q.agentId) {
      where.push("c.agent_id = ?");
      params.push(q.agentId);
    }
    const term = q.q?.trim() || undefined;
    if (term) {
      const like = `%${term.toLowerCase()}%`;
      where.push("(lower(c.title) LIKE ? OR lower(c.description) LIKE ? OR lower(c.tags) LIKE ?)");
      params.push(like, like, like);
    }
    return { where: where.length ? ` WHERE ${where.join(" AND ")}` : "", params, term };
  }

  /** Number of rows `query` would match with the same filters (limit/offset/sort ignored). */
  async countMatching(q: ContentQuery = {}): Promise<number> {
    const { where, params } = this.whereFor(q);
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM content c JOIN agents a ON a.id = c.agent_id JOIN categories k ON k.id = c.category_id${where}`)
      .bind(...params)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async query(q: ContentQuery = {}): Promise<ContentCard[]> {
    const { where, params, term } = this.whereFor(q);
    const order =
      q.sort === "newest"
        ? "c.published_at DESC, c.created_at DESC"
        : q.sort === "views"
          ? "c.views DESC"
          : // trending: engagement with a mild recency bias via views + likes*25
            "(c.views + c.likes * 25) DESC, c.published_at DESC";
    // Title hits rank above description/tag hits when searching.
    const rank = term ? `CASE WHEN lower(c.title) LIKE ? THEN 0 ELSE 1 END, ` : "";
    if (term) params.push(`%${term.toLowerCase()}%`);
    const limit = Math.min(Math.max(q.limit ?? 24, 1), 100);
    const offset = Math.max(q.offset ?? 0, 0);
    params.push(limit, offset);
    const sql = `${CARD_SELECT}${where} ORDER BY ${rank}${order} LIMIT ? OFFSET ?`;
    const rows = await this.db.prepare(sql).bind(...params).all<CardRow>();
    return rows.map(mapCard);
  }

  async related(content: Content, limit = 8): Promise<ContentCard[]> {
    const rows = await this.db
      .prepare(
        `${CARD_SELECT} WHERE c.status = 'published' AND c.id != ?
         ORDER BY (c.category_id = ?) DESC, (c.agent_id = ?) DESC, c.views DESC LIMIT ?`,
      )
      .bind(content.id, content.category_id, content.agent_id, limit)
      .all<CardRow>();
    return rows.map(mapCard);
  }

  async countByAgent(agentId: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM content WHERE agent_id = ? AND status = 'published'")
      .bind(agentId)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async count(status: ContentStatus | "any" = "published"): Promise<number> {
    const r =
      status === "any"
        ? await this.db.prepare("SELECT COUNT(*) AS n FROM content").first<{ n: number }>()
        : await this.db
            .prepare("SELECT COUNT(*) AS n FROM content WHERE status = ?")
            .bind(status)
            .first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** Published content that owns this media key, or null. Used to decide whether media is public. */
  async getPublishedByMediaKey(mediaKey: string): Promise<Content | null> {
    const row = await this.db
      .prepare("SELECT * FROM content WHERE media_key = ? AND status = 'published'")
      .bind(mediaKey)
      .first<ContentRow>();
    return row ? mapContent(row) : null;
  }

  async incrementViews(id: string): Promise<void> {
    await this.db.prepare("UPDATE content SET views = views + 1 WHERE id = ?").bind(id).run();
  }

  async attachMedia(id: string, mediaKey: string, durationSeconds?: number): Promise<void> {
    await this.db
      .prepare(
        "UPDATE content SET media_key = ?, duration_seconds = COALESCE(?, duration_seconds), updated_at = ? WHERE id = ?",
      )
      .bind(mediaKey, durationSeconds ?? null, nowIso(), id)
      .run();
  }

  /** Fenced attach: only the job's current lease holder may point content at a render. */
  async attachMediaOwned(id: string, mediaKey: string, durationSeconds: number | undefined, fence: LeaseFence): Promise<void> {
    const { changes } = await this.db
      .prepare(
        `UPDATE content SET media_key = ?, duration_seconds = COALESCE(?, duration_seconds), updated_at = ? WHERE id = ? AND ${LEASE_FENCE_SQL}`,
      )
      .bind(mediaKey, durationSeconds ?? null, nowIso(), id, ...leaseFenceParams(fence))
      .run();
    if (changes !== 1) throw new LeaseLostError(fence.jobId, fence.owner, "fenced media attach refused");
  }

  async setStatus(id: string, status: ContentStatus): Promise<void> {
    const ts = nowIso();
    await this.db
      .prepare(
        "UPDATE content SET status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?",
      )
      .bind(status, status, ts, ts, id)
      .run();
  }
}
