import { describe, expect, it } from "vitest";
import { freshRepos } from "./helpers";
import { exploreHref, parseSort } from "@/lib/nav";

describe("content search", () => {
  it("matches title, description and tags case-insensitively", async () => {
    const { repos } = await freshRepos();
    const byTitle = await repos.content.query({ q: "IMMERSION" });
    expect(byTitle.some((c) => c.title.includes("Immersion Tank Reveal"))).toBe(true);
    const byTag = await repos.content.query({ q: "nvidia-smi" });
    expect(byTag.map((c) => c.title)).toContain("Full Load: 8x H100 Hit 100% Utilization for 40 Minutes");
  });

  it("ranks title hits above description-only hits", async () => {
    const { repos } = await freshRepos();
    const results = await repos.content.query({ q: "rack", sort: "views" });
    const firstDescOnly = results.findIndex((c) => !c.title.toLowerCase().includes("rack"));
    const lastTitleHit = results.map((c) => c.title.toLowerCase().includes("rack")).lastIndexOf(true);
    expect(firstDescOnly === -1 || lastTitleHit < firstDescOnly).toBe(true);
  });

  it("filters by category and sorts by newest / views", async () => {
    const { repos } = await freshRepos();
    const newest = await repos.content.query({ categorySlug: "liquid-cooling", sort: "newest" });
    expect(newest.every((c) => c.category_slug === "liquid-cooling")).toBe(true);
    for (let i = 1; i < newest.length; i++) expect(newest[i - 1].published_at! >= newest[i].published_at!).toBe(true);
    const views = await repos.content.query({ sort: "views", limit: 5 });
    for (let i = 1; i < views.length; i++) expect(views[i - 1].views).toBeGreaterThanOrEqual(views[i].views);
  });

  it("returns an empty list for nonsense and clamps limit", async () => {
    const { repos } = await freshRepos();
    expect(await repos.content.query({ q: "zzzzqqq" })).toEqual([]);
    expect((await repos.content.query({ limit: 1000 })).length).toBeLessThanOrEqual(100);
    expect((await repos.content.query({ limit: 0 })).length).toBe(1);
  });

  it("related prefers same category, excludes self", async () => {
    const { repos } = await freshRepos();
    const [video] = await repos.content.query({ categorySlug: "overclocked", limit: 1 });
    const related = await repos.content.related(video, 3);
    expect(related.map((r) => r.id)).not.toContain(video.id);
    expect(related[0].category_slug).toBe("overclocked");
  });
});

describe("navigation helpers", () => {
  it("builds explore links and parses sort safely", () => {
    expect(exploreHref({})).toBe("/explore");
    expect(exploreHref({ q: "rack", category: "hot-racks", sort: "newest" })).toBe("/explore?q=rack&category=hot-racks&sort=newest");
    expect(exploreHref({ sort: "trending" })).toBe("/explore");
    expect(parseSort("views")).toBe("views");
    expect(parseSort("DROP TABLE")).toBe("trending");
  });
});
