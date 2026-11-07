import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appleChartSource, categoryMetricSource, categoryPlans, previousRank, readCategoryHistory, readCategoryRanks, saveCategoryRanks, type ChartSource } from "./category.js";
import { outcomeVerdict, compareWindows } from "./metrics.js";
import { makeProject } from "./test-helpers.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("category charts", () => {
  it("reads Apple's per-genre chart and finds the app", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return json({ feed: { entry: [{ id: { attributes: { "im:id": "7" } } }, { id: { attributes: { "im:id": "123" } } }] } });
    }) as unknown as typeof fetch;
    const ids = await appleChartSource(fetcher).chart("app-store", "6013", "us", "top-free");
    expect(ids).toEqual(["7", "123"]);
    expect(urls[0]).toBe("https://itunes.apple.com/us/rss/topfreeapplications/limit=100/genre=6013/json");
  });

  it("takes the genre and chart from the App Store app when the spec leaves them out", async () => {
    const project = makeProject({ targets: { us: ["sleep"], tr: ["uyku"] }, stores: { appStore: { appId: "123" }, googlePlay: { packageName: "com.example.sleep" } } });
    const fetcher = (async () => json({ results: [{ primaryGenreId: 6013, primaryGenreName: "Health & Fitness", price: 2.99 }] })) as unknown as typeof fetch;
    const { plans, notes } = await categoryPlans(project, fetcher);
    expect(plans).toEqual([{ store: "app-store", appId: "123", category: "6013", chart: "top-paid", countries: ["us", "tr"], name: "Health & Fitness" }]);
    expect(notes[0]).toMatch(/category.googlePlay/);
  });

  it("records one row per day and storefront; out of the chart is an empty rank", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-category-"));
    const source: ChartSource = { label: "fake", chart: async (_s, _c, country) => (country === "us" ? ["1", "123"] : country === "tr" ? ["1"] : null) };
    const plans = [{ store: "app-store" as const, appId: "123", category: "6013", chart: "top-free" as const, countries: ["us", "tr", "de"] }];
    const { ranks, failed } = await readCategoryRanks(plans, source, new Date("2026-11-05T06:00:00Z"));
    expect(ranks.map((r) => [r.country, r.rank])).toEqual([["us", 2], ["tr", null]]);
    expect(failed).toEqual(["app-store DE: chart not available"]);
    await saveCategoryRanks(root, ranks);
    await saveCategoryRanks(root, ranks.map((r) => ({ ...r, rank: r.rank && r.rank - 1 }))); // same day again: replaced, not added
    const csv = readFileSync(join(root, "appeeky", "category.csv"), "utf8");
    expect(csv).toBe("date,store,country,chart,category,rank\n2026-11-05,app-store,tr,top-free,6013,\n2026-11-05,app-store,us,top-free,6013,1\n");
    const history = await readCategoryHistory(root);
    expect(previousRank(history, { ...ranks[0]!, date: "2026-11-06" })?.rank).toBe(1);
  });

  it("gives verify a category_rank that is better when it goes down, and decides a release with no other data", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-category-"));
    const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
    const rows = [];
    for (let d = 1; d <= 7; d++) rows.push({ date: day(d), store: "app-store" as const, country: "us", chart: "top-free" as const, category: "6013", rank: 40 });
    for (let d = 9; d <= 15; d++) rows.push({ date: day(d), store: "app-store" as const, country: "us", chart: "top-free" as const, category: "6013", rank: 30 });
    await saveCategoryRanks(root, rows);
    const source = categoryMetricSource(root);
    const before = (await source.window("app-store", "123", day(1), day(8)))!;
    const after = (await source.window("app-store", "123", day(9), day(16)))!;
    expect(before.values.category_rank).toBe(40);
    const changes = compareWindows(before, after);
    expect(changes).toEqual([{ metric: "category_rank", before: 40, after: 30, change: -0.25, outcome: "better" }]);
    expect(outcomeVerdict(changes)).toEqual({ verdict: "won", by: ["category_rank"] });
    expect(await source.window("google-play", "x", day(1), day(8))).toBeNull();
  });
});
