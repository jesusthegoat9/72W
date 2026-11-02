import { describe, expect, it } from "vitest";
import { freshRepos } from "./helpers";
import { categoryHref, exploreHref, parseSort } from "@/lib/nav";
import { PAGE_SIZE, paginate, parsePage } from "@/lib/paging";

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

describe("pagination", () => {
  it("countMatching agrees with query for every filter and pages tile the result set", async () => {
    const { repos } = await freshRepos();
    const filters = [{}, { q: "rack" }, { categorySlug: "liquid-cooling" }, { q: "fan", categorySlug: "full-load" }, { q: "no-such-term-anywhere" }, { status: "any" as const }];
    for (const f of filters) {
      const all = await repos.content.query({ ...f, limit: 100 });
      expect(await repos.content.countMatching(f), JSON.stringify(f)).toBe(all.length);
    }
    const total = await repos.content.countMatching({});
    expect(total).toBeGreaterThan(PAGE_SIZE);
    const seen = new Set<string>();
    const pages = Math.ceil(total / PAGE_SIZE);
    for (let p = 1; p <= pages; p++) {
      const { offset, size } = paginate(total, p);
      const rows = await repos.content.query({ sort: "newest", limit: size, offset });
      expect(rows.length).toBe(p < pages ? PAGE_SIZE : total - (pages - 1) * PAGE_SIZE);
      for (const r of rows) {
        expect(seen.has(r.id), `duplicate ${r.slug} on page ${p}`).toBe(false);
        seen.add(r.id);
      }
    }
    expect(seen.size).toBe(total);
    expect(await repos.content.query({ sort: "newest", limit: PAGE_SIZE, offset: pages * PAGE_SIZE })).toEqual([]);
  });

  it("paginate clamps and parsePage never throws", () => {
    expect(paginate(0, 1)).toMatchObject({ page: 1, pages: 1, offset: 0, from: 0, to: 0, total: 0 });
    expect(paginate(66, 1)).toMatchObject({ page: 1, pages: 3, offset: 0, from: 1, to: 24 });
    expect(paginate(66, 3)).toMatchObject({ page: 3, pages: 3, offset: 48, from: 49, to: 66 });
    expect(paginate(66, 99)).toMatchObject({ page: 3, offset: 48 });
    expect(paginate(66, 0)).toMatchObject({ page: 1 });
    expect(paginate(66, Number.NaN)).toMatchObject({ page: 1 });
    expect(paginate(24, 2)).toMatchObject({ page: 1, pages: 1 });
    expect(paginate(25, 2)).toMatchObject({ page: 2, pages: 2, from: 25, to: 25 });
    expect(paginate(10, 1, 4)).toMatchObject({ pages: 3, size: 4 });
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("2")).toBe(2);
    expect(parsePage("10000")).toBe(10000);
    for (const bad of ["0", "-3", "x", "2.5", "1e2", " 2", "10001", "999999"]) expect(parsePage(bad), bad).toBe(1);
  });

  it("page-aware hrefs omit defaults and keep filters", () => {
    expect(exploreHref({ page: 1 })).toBe("/explore");
    expect(exploreHref({ page: 2 })).toBe("/explore?page=2");
    expect(exploreHref({ q: "rack", category: "hot-racks", sort: "newest", page: 3 })).toBe("/explore?q=rack&category=hot-racks&sort=newest&page=3");
    expect(categoryHref("hot-racks")).toBe("/category/hot-racks");
    expect(categoryHref("hot-racks", { sort: "trending", page: 1 })).toBe("/category/hot-racks");
    expect(categoryHref("hot-racks", { sort: "views", page: 2 })).toBe("/category/hot-racks?sort=views&page=2");
  });
});
