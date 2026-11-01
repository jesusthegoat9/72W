/**
 * Minimal SQL database interface shaped after Cloudflare D1's prepared
 * statement API, so repositories are written once and run unchanged on
 * D1 in production and on node:sqlite locally and in tests.
 */

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<T extends object = Row>(): Promise<T | null>;
  all<T extends object = Row>(): Promise<T[]>;
  run(): Promise<{ changes: number }>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /** Run one or more statements with no result (DDL, migrations). */
  exec(sql: string): Promise<void>;
  /** Run statements sequentially in one transaction where supported. */
  batch(statements: SqlStatement[]): Promise<void>;
}
