import type { SqlDatabase } from "../db/database";
import { newId, nowIso } from "../db/ids";
import type { Category, CategoryRow } from "../db/types";

export interface NewCategory {
  slug: string;
  name: string;
  description: string;
  sortOrder?: number;
}

export class CategoriesRepo {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<Category[]> {
    return this.db
      .prepare("SELECT * FROM categories ORDER BY sort_order ASC, name ASC")
      .all<CategoryRow>();
  }

  async getBySlug(slug: string): Promise<Category | null> {
    return this.db.prepare("SELECT * FROM categories WHERE slug = ?").bind(slug).first<CategoryRow>();
  }

  async getById(id: string): Promise<Category | null> {
    return this.db.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first<CategoryRow>();
  }

  async insert(input: NewCategory): Promise<Category> {
    const id = newId("cat");
    await this.db
      .prepare(
        "INSERT INTO categories (id, slug, name, description, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, input.slug, input.name, input.description, input.sortOrder ?? 0, nowIso())
      .run();
    return (await this.getById(id))!;
  }
}
