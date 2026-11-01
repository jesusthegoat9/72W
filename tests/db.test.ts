import { describe, expect, it } from "vitest";
import { freshRepos } from "./helpers";
import { migrate } from "@/server/db/migrate";
import { SqliteDatabase } from "@/server/db/sqlite";

describe("migrations", () => {
  it("apply once and are recorded", async () => {
    const db = new SqliteDatabase(":memory:");
    const first = await migrate(db);
    expect(first).toEqual(["0001_init.sql", "0002_indexes.sql", "0003_leases.sql"]);
    const second = await migrate(db);
    expect(second).toEqual([]);
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["agents", "categories", "content", "generation_jobs", "activity_log"]));
  });
});

describe("migrations", () => {
  it("roll back a failing migration file and apply the later index migration to an older database", async () => {
    const { mkdtemp, writeFile, copyFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "x86xx-mig-"));
    await copyFile(path.join(process.cwd(), "migrations/0001_init.sql"), path.join(dir, "0001_init.sql"));
    await writeFile(path.join(dir, "0002_bad.sql"), "CREATE TABLE extra (id TEXT PRIMARY KEY);\nINSERT INTO nope VALUES (1);");
    const db = new SqliteDatabase(":memory:");
    await expect(migrate(db, dir)).rejects.toThrow(/0002_bad.sql failed and was rolled back/);
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()).map((t) => t.name);
    expect(tables).toContain("agents");
    expect(tables).not.toContain("extra");
    expect((await db.prepare("SELECT name FROM _migrations").all<{ name: string }>()).map((r) => r.name)).toEqual(["0001_init.sql"]);

    // A database created before 0002 existed picks it up on the next run.
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all<{ name: string }>()).map((i) => i.name);
    expect(indexes).not.toContain("idx_content_media_key");
    expect(await migrate(db)).toEqual(["0002_indexes.sql", "0003_leases.sql"]);
    const after = (await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all<{ name: string }>()).map((i) => i.name);
    expect(after).toEqual(expect.arrayContaining(["idx_content_media_key", "idx_activity_job", "idx_activity_content", "idx_jobs_processing"]));
  });
});

describe("seed + repositories", () => {
  it("seeds categories, agents and published content idempotently", async () => {
    const { repos } = await freshRepos();
    expect(await repos.agents.count()).toBe(5);
    const slugs = (await repos.categories.list()).map((c) => c.slug);
    expect(slugs).toContain("data-center-after-dark");
    for (const s of ["fresh-out-the-box", "hardcore-processing", "group-compute", "hot-swaps", "thermal-paste", "unlimited-context", "no-rate-limits", "clean-builds"]) {
      expect(slugs).toContain(s);
      expect((await repos.content.query({ categorySlug: s })).length).toBeGreaterThanOrEqual(3);
    }
    const before = await repos.content.count("any");
    const { seedCatalogue } = await import("@/server/seed");
    expect((await seedCatalogue(repos)).seeded).toBe(false);
    expect(await repos.content.count("any")).toBe(before);
  });

  it("seeds additively: missing categories and videos are added, existing rows untouched", async () => {
    const { db, repos } = await freshRepos();
    const { seedCatalogue } = await import("@/server/seed");
    const before = await repos.content.count("any");
    expect((await repos.categories.list()).length).toBe(16);

    // Simulate an older database that predates one category.
    const slug = "thermal-paste";
    const cat = (await repos.categories.getBySlug(slug))!;
    await db.prepare("DELETE FROM activity_log WHERE content_id IN (SELECT id FROM content WHERE category_id = ?)").bind(cat.id).run();
    const removed = (await db.prepare("DELETE FROM content WHERE category_id = ?").bind(cat.id).run()).changes;
    await db.prepare("DELETE FROM categories WHERE id = ?").bind(cat.id).run();
    expect(removed).toBeGreaterThan(0);

    const agentBefore = (await repos.agents.getByHandle("rackdaddy"))!;
    const result = await seedCatalogue(repos);
    expect(result).toMatchObject({ seeded: false, categories: 1, agents: 0, videos: removed });
    expect(await repos.content.count("any")).toBe(before);
    expect((await repos.agents.getByHandle("rackdaddy"))!.id).toBe(agentBefore.id);
    expect((await repos.content.query({ categorySlug: slug })).length).toBe(removed);
    // Running again changes nothing.
    expect(await seedCatalogue(repos)).toMatchObject({ seeded: false, categories: 0, agents: 0, videos: 0 });
  });

  it("isolates content by agent", async () => {
    const { repos } = await freshRepos();
    const carla = (await repos.agents.getByHandle("coolantcarla"))!;
    const monk = (await repos.agents.getByHandle("cablemonk"))!;
    const carlas = await repos.content.query({ agentId: carla.id, limit: 100 });
    expect(carlas.length).toBeGreaterThan(0);
    expect(carlas.every((c) => c.agent_id === carla.id)).toBe(true);
    expect(carlas.some((c) => c.agent_id === monk.id)).toBe(false);
    expect(await repos.content.countByAgent(carla.id)).toBe(carlas.length);
  });

  it("hides drafts from the public query and shows them with status=any", async () => {
    const { repos } = await freshRepos();
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("hot-racks"))!;
    const draft = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Secret Draft Rack", description: "not yet", status: "draft" });
    expect((await repos.content.query({ q: "secret draft" })).length).toBe(0);
    expect((await repos.content.query({ q: "secret draft", status: "any" })).map((c) => c.id)).toEqual([draft.id]);
    expect(await repos.content.getCard(draft.slug)).toMatchObject({ id: draft.id, status: "draft" });
  });

  it("generates unique slugs for duplicate titles", async () => {
    const { repos } = await freshRepos();
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("hot-racks"))!;
    const a = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Same Title", description: "x" });
    const b = await repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Same Title", description: "y" });
    expect(a.slug).toBe("same-title");
    expect(b.slug).toBe("same-title-2");
  });

  it("allocates unique slugs under concurrent inserts of the same title", async () => {
    const { repos } = await freshRepos();
    const agent = (await repos.agents.getByHandle("rackdaddy"))!;
    const cat = (await repos.categories.getBySlug("hot-racks"))!;
    const rows = await Promise.all(Array.from({ length: 6 }, (_, i) => repos.content.insert({ agentId: agent.id, categoryId: cat.id, title: "Racy Rack", description: String(i) })));
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(6);
    expect(slugs).toContain("racy-rack");
  });

  it("enforces foreign keys", async () => {
    const { repos } = await freshRepos();
    const cat = (await repos.categories.getBySlug("hot-racks"))!;
    await expect(repos.content.insert({ agentId: "agt_missing", categoryId: cat.id, title: "Orphan", description: "x" })).rejects.toThrow();
  });
});
