import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase, SqlStatement, SqlValue, Row } from "./database";

/** Local adapter over Node's built-in SQLite. Used for dev and tests. */
export class SqliteDatabase implements SqlDatabase {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  }

  prepare(sql: string): SqlStatement {
    return new SqliteStatement(this.raw, sql, []);
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    this.raw.exec("BEGIN");
    try {
      for (const s of statements) await s.run();
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close() {
    this.raw.close();
  }
}

class SqliteStatement implements SqlStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: SqlValue[],
  ) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async first<T extends object = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values) as T | undefined;
    return row ?? null;
  }

  async all<T extends object = Row>(): Promise<T[]> {
    return this.db.prepare(this.sql).all(...this.values) as T[];
  }

  async run(): Promise<{ changes: number }> {
    const r = this.db.prepare(this.sql).run(...this.values);
    return { changes: Number(r.changes) };
  }
}
