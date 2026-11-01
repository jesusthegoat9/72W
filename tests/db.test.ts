import { describe, expect, it } from "vitest";
import { freshRepos } from "./helpers";
import { migrate } from "@/server/db/migrate";
import { SqliteDatabase } from "@/server/db/sqlite";

describe("migrations", () => {
  it("apply once and are recorded", async () => {
    const db = new SqliteDatabase(":memory:");
    const first = await migrate(db);
    expect(first).toEqual(["0001_init.sql"]);
    const second = await migrate(db);
    expect(second).toEqual([]);
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["agents", "categories", "content", "generation_jobs", "activity_log"]));
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

  it("enforces foreign keys", async () => {
    const { repos } = await freshRepos();
    const cat = (await repos.categories.getBySlug("hot-racks"))!;
    await expect(repos.content.insert({ agentId: "agt_missing", categoryId: cat.id, title: "Orphan", description: "x" })).rejects.toThrow();
  });
});
