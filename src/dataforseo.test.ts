import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { locationCode, pullDomain, pullKeywords, pullRanks, quoteSeo, readDataForSeo, readSerp, webKeywords, webRankMetricSource } from "./dataforseo.js";
import { makeProject } from "./test-helpers.js";

const auth = { login: "me@x.com", password: "pw" };
const task = (result: unknown[], cost = 0.02) => new Response(JSON.stringify({ status_code: 20000, cost, tasks: [{ status_code: 20000, status_message: "Ok.", result }] }), { status: 200 });

const serp = (mine: number | null, aiCitesYou: boolean) => [
  {
    items: [
      { type: "ai_overview", references: [{ domain: aiCitesYou ? "www.sleepsounds.app" : "calm.com" }], items: [{ type: "ai_overview_element", references: [{ url: "https://reddit.com/r/sleep" }] }] },
      { type: "organic", rank_group: 1, domain: "calm.com", url: "https://calm.com/" },
      { type: "organic", rank_group: 2, domain: "apps.apple.com", url: "https://apps.apple.com/us/app/sleep-sounds/id123" },
      ...(mine ? [{ type: "organic", rank_group: mine, domain: "www.sleepsounds.app", url: "https://www.sleepsounds.app/rain" }] : []),
    ],
  },
];

const project = (root: string) => ({ ...makeProject({ targets: { us: ["rain sounds", "white noise"] }, web: { url: "https://sleepsounds.app/" } }), root });

describe("DataForSEO on your own account", () => {
  it("needs both login and password, and maps storefronts to locations", () => {
    expect(readDataForSeo({})).toBeNull();
    expect(() => readDataForSeo({ DATAFORSEO_LOGIN: "a" })).toThrow("DATAFORSEO_PASSWORD");
    expect(locationCode("us")).toBe(2840);
    expect(locationCode("tr")).toBe(2792);
    expect(webKeywords(makeProject({ targets: { us: ["Rain Sounds"], tr: ["uyku"] } }))).toEqual({ us: ["rain sounds"] });
    expect(webKeywords(makeProject({ targets: { us: ["a"] }, web: { url: "https://x.app", countries: ["us", "tr"], keywords: { tr: ["uyku sesleri"] } } }))).toEqual({ us: ["a"], tr: ["uyku sesleri"] });
  });

  it("reads the site's position, the store page and the AI Overview from a results page", () => {
    const r = readSerp(serp(7, true)[0]!.items, "sleepsounds.app", [/apps\.apple\.com\/.*id123/]);
    expect(r).toEqual({ position: 7, url: "https://www.sleepsounds.app/rain", storePosition: 2, aiOverview: true, aiCitesYou: true, aiCited: ["sleepsounds.app", "reddit.com"], top: ["calm.com", "apps.apple.com", "sleepsounds.app"] });
  });

  it("records ranks per day, notes what moved, and measures them", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-dfs-"));
    const p = project(root);
    const bodies: Array<Record<string, unknown>> = [];
    let week = 0;
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body))[0] as Record<string, unknown>;
      bodies.push(body);
      return task(week === 0 ? serp(14, false) : serp(body.keyword === "rain sounds" ? 6 : null, body.keyword === "rain sounds"));
    }) as typeof fetch;
    await pullRanks(p, auth, { fetcher, now: new Date("2026-11-01T00:00:00Z") });
    expect(bodies[0]).toMatchObject({ keyword: "rain sounds", location_code: 2840, language_code: "en", device: "mobile", load_async_ai_overview: true });
    week = 1;
    const r = await pullRanks(p, auth, { fetcher, now: new Date("2026-11-08T00:00:00Z") });
    expect(r.costUsd).toBe(0.04);
    expect(r.changes).toEqual(['US "rain sounds": into the top 10 (14 → 6)', 'US "rain sounds": Google\'s AI Overview now cites the site']);
    expect(readFileSync(join(root, "appeeky/seo/ranks.csv"), "utf8").trim().split("\n")).toHaveLength(5);
    expect(readFileSync(join(root, "appeeky/seo/changes.md"), "utf8")).toContain("- 2026-11-08 · US \"rain sounds\": into the top 10");
    expect(readFileSync(join(root, "appeeky/seo/ranks.md"), "utf8")).toContain("| US rain sounds | 6 | 2 | cites you | calm.com, apps.apple.com, sleepsounds.app |");

    const m = webRankMetricSource(root)!;
    expect((await m.window("app-store", "123", "2026-11-01", "2026-11-02"))?.values).toEqual({ web_rank: 14, ai_overview_citations: 0 });
    expect((await m.window("app-store", "123", "2026-11-08", "2026-11-09"))?.values).toEqual({ web_rank: 53.5, ai_overview_citations: 0.5 });
  });

  it("writes keyword data with ideas, and the domain report", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-dfs-"));
    const p = project(root);
    const fetcher = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("keyword_overview/live")) return task([{ items: [{ keyword: "rain sounds", keyword_info: { search_volume: 9900, cpc: 1.2 }, keyword_properties: { keyword_difficulty: 31 }, search_intent_info: { main_intent: "navigational" } }] }]);
      if (u.endsWith("related_keywords/live")) return task([{ items: [{ keyword_data: { keyword: "thunder sounds", keyword_info: { search_volume: 2400 } } }, { keyword_data: { keyword: "rain sounds" } }] }]);
      if (u.endsWith("domain_rank_overview/live")) return task([{ items: [{ metrics: { organic: { count: 40, etv: 512.4, pos_1: 2, pos_2_3: 3, pos_4_10: 5 } } }] }]);
      if (u.endsWith("ranked_keywords/live")) return task([{ items: [{ keyword_data: { keyword: "rain sounds", keyword_info: { search_volume: 9900 } }, ranked_serp_element: { serp_item: { rank_group: 4, url: "https://sleepsounds.app/rain", etv: 300 } } }] }]);
      if (u.endsWith("competitors_domain/live")) return task([{ items: [{ domain: "sleepsounds.app", intersections: 40 }, { domain: "reddit.com", intersections: 30 }, { domain: "calm.com", intersections: 12, avg_position: 6.25 }] }]);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const k = await pullKeywords(p, auth, { fetcher, seeds: 1 });
    expect(k.rows.map((r) => [r.keyword, r.volume, r.tracked])).toEqual([
      ["rain sounds", 9900, true],
      ["white noise", null, true],
      ["thunder sounds", 2400, false],
    ]);
    expect(readFileSync(join(root, "appeeky/seo/keywords.csv"), "utf8")).toContain("us,rain sounds,9900,31,1.2,navigational,yes");

    const d = await pullDomain(p, auth, { fetcher });
    expect(d.report).toMatchObject({ domain: "sleepsounds.app", keywords: 40, traffic: 512, top3: 5, top10: 10, competitors: [{ domain: "calm.com", common: 12, avgPosition: 6.25 }] });
    expect(readFileSync(join(root, "appeeky/seo/domain.md"), "utf8")).toContain("| rain sounds | 4 | 9900 | yes |");
    expect(quoteSeo(p, "ranks")).toBe(0.04);
  });

  it("explains a failed task instead of writing empty files", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-dfs-"));
    const fetcher = (async () => new Response(JSON.stringify({ status_code: 20000, cost: 0, tasks: [{ status_code: 40200, status_message: "Payment Required.", result: null }] }), { status: 200 })) as typeof fetch;
    const r = await pullRanks(project(root), auth, { fetcher });
    expect(r.errors).toEqual(['US "rain sounds": DataForSEO: Payment Required. Add funds at app.dataforseo.com.']);
  });
});
