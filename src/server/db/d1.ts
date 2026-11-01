import type { SqlDatabase, SqlStatement, SqlValue, Row } from "./database";

/**
 * Structural subset of Cloudflare's D1Database binding, declared here so the
 * app compiles without @cloudflare/workers-types. Matches the documented API.
 */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  exec(sql: string): Promise<unknown>;
  batch(statements: D1StatementLike[]): Promise<unknown>;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

/** Production adapter: wraps a D1 binding (env.DB) behind SqlDatabase. */
export class D1Database implements SqlDatabase {
  constructor(private readonly d1: D1Like) {}

  prepare(sql: string): SqlStatement {
    return new D1Statement(this.d1.prepare(sql));
  }
  async exec(sql: string): Promise<void> {
    await this.d1.exec(sql);
  }
  async batch(statements: SqlStatement[]): Promise<void> {
    await this.d1.batch(statements.map((s) => (s as D1Statement).inner));
  }
}

class D1Statement implements SqlStatement {
  constructor(readonly inner: D1StatementLike) {}
  bind(...values: SqlValue[]): SqlStatement {
    return new D1Statement(this.inner.bind(...values));
  }
  async first<T extends object = Row>(): Promise<T | null> {
    return this.inner.first<T>();
  }
  async all<T extends object = Row>(): Promise<T[]> {
    return (await this.inner.all<T>()).results;
  }
  async run(): Promise<{ changes: number }> {
    return { changes: (await this.inner.run()).meta.changes };
  }
}
