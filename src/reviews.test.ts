import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { AppeekyApi } from "./appeeky-api.js";
import { fetchCompetitorStore } from "./competitors.js";
import { dateChunks, mergeCsv, pullData } from "./data.js";
import { specFileSchema, type Project } from "./schema.js";
import { fetchReviews, readReplies, readReviews, replyIssues, reviewMetricSource, reviewStats, saveReviews, sendReply, summaryMarkdown, writeReply, type Review } from "./reviews.js";

function fakeApi(routes: Record<string, (q: URLSearchParams, body?: unknown) => unknown>) {
  const calls: Array<{ url: URL; body?: unknown }> = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const route = Object.keys(routes).find((p) => url.pathname.endsWith(p));
    if (!route) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    return new Response(JSON.stringify({ data: routes[route]!(url.searchParams, body) }), { status: 200 });
  }) as typeof fetch;
  return { api: new AppeekyApi("key", { baseUrl: "https://api.test/v1", fetcher }), calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), "spec-reviews-"));
const review = (over: Partial<Review>): Review => ({ id: "1", store: "app-store", rating: 5, body: "Great", date: "2026-10-20T10:00:00Z", ...over });

describe("reviews", () => {
  it("pages back through App Store reviews and maps both stores", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `a${from + i}`, rating: 4, title: "Nice", body: "Calm", reviewer_nickname: "x", territory: "USA", app_version: "3.1", review_created_at: `2026-10-${String(28 - Math.floor((from + i) / 10)).padStart(2, "0")}T00:00:00Z`, response_body: null, response_last_modified: null }));
    const { api, calls } = fakeApi({
      "/connect/reviews": (q) => ({ reviews: q.get("before") ? page(3, 200) : page(200, 0) }),
      "/connect/google-play/reviews": () => ({ reviews: [{ review_id: "g1", author_name: "A", reviewer_language: "en", star_rating: 2, review_text: "Crashes", review_last_modified_at: "2026-10-02T00:00:00Z", app_version_name: "3.0", developer_reply_text: "Fixed in 3.1", developer_reply_last_modified_at: "2026-10-03T00:00:00Z" }] }),
    });
    const asc = await fetchReviews(api, "app-store", "123");
    expect(asc).toHaveLength(203);
    expect(calls.filter((c) => c.url.pathname.endsWith("/connect/reviews")).map((c) => c.url.searchParams.get("appId"))).toEqual(["123", "123"]);
    expect(asc[0]).toEqual({ id: "a0", store: "app-store", rating: 4, title: "Nice", body: "Calm", author: "x", where: "USA", version: "3.1", date: "2026-10-28T00:00:00Z" });
    const play = await fetchReviews(api, "google-play", "com.example.sleep");
    expect(play[0]).toMatchObject({ id: "g1", store: "google-play", rating: 2, reply: { body: "Fixed in 3.1" } });
  });

  it("stops at --since", async () => {
    const { api } = fakeApi({ "/connect/reviews": () => ({ reviews: [{ id: "n", rating: 5, title: null, body: "", reviewer_nickname: null, territory: null, app_version: null, review_created_at: "2026-10-10T00:00:00Z", response_body: null, response_last_modified: null }, { id: "o", rating: 5, title: null, body: "", reviewer_nickname: null, territory: null, app_version: null, review_created_at: "2026-09-01T00:00:00Z", response_body: null, response_last_modified: null }] }) });
    expect((await fetchReviews(api, "app-store", "1", { since: "2026-10-01" })).map((r) => r.id)).toEqual(["n"]);
  });

  it("saves one file per month and replaces a review that changed", async () => {
    const root = tmp();
    expect(await saveReviews(root, [review({ id: "1" }), review({ id: "2", date: "2026-09-30T00:00:00Z" })])).toEqual({ added: 2, updated: 0 });
    expect(readdirSync(join(root, "appeeky", "reviews", "app-store")).sort()).toEqual(["2026-09.jsonl", "2026-10.jsonl"]);
    expect(await saveReviews(root, [review({ id: "1", reply: { body: "Thanks!" } })])).toEqual({ added: 0, updated: 1 });
    const all = await readReviews(root);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === "1")?.reply?.body).toBe("Thanks!");
  });

  it("summarizes the last 30 days against the 30 before", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    const md = summaryMarkdown(
      [review({ id: "1", rating: 1, date: "2026-10-30T00:00:00Z", version: "3.1", body: "Crashes on launch" }), review({ id: "2", rating: 5, date: "2026-10-20T00:00:00Z", version: "3.1" }), review({ id: "3", rating: 4, date: "2026-09-20T00:00:00Z", version: "3.0", reply: { body: "ok" } })],
      now,
    );
    expect(md).toContain("| last 30 days | 2 | 3.00 | 50% | 2 |");
    expect(md).toContain("| 30 days before | 1 | 4.00 | 0% | 0 |");
    expect(md).toContain("| 3.1 | 2 | 3.00 | 50% |");
    expect(md).toContain("`1` 1★ 2026-10-30: Crashes on launch");
    expect(reviewStats([]).average).toBeNull();
  });

  it("drafts a reply, checks its length and sends it to the right store", async () => {
    const root = tmp();
    await writeReply(root, { id: "a1", store: "app-store", text: "Thanks, fixed in 3.1." });
    await writeReply(root, { id: "g1", store: "google-play", text: "x".repeat(400) });
    const [asc, play] = await readReplies(root);
    expect(replyIssues(play!)).toEqual(["400/350 characters"]);
    const { api, calls } = fakeApi({ "/response": () => ({ ok: true }), "/reply": () => ({ ok: true }) });
    await sendReply(api, asc!, undefined, new Date("2026-11-04T00:00:00Z"));
    await sendReply(api, { ...play!, text: "Sorry about that." }, "com.example.sleep");
    expect(calls[0]!.url.pathname).toBe("/v1/connect/reviews/a1/response");
    expect(calls[0]!.body).toEqual({ responseBody: "Thanks, fixed in 3.1." });
    expect(calls[1]!.url.pathname).toBe("/v1/connect/google-play/apps/com.example.sleep/reviews/g1/reply");
    expect(calls[1]!.body).toEqual({ replyText: "Sorry about that." });
    expect(YAML.parse(readFileSync(asc!.file, "utf8"))).toMatchObject({ status: "sent", sentAt: "2026-11-04T00:00:00.000Z" });
  });

  it("measures ratings around a push from the files, and needs a few reviews", async () => {
    const root = tmp();
    await saveReviews(root, [1, 2, 3, 4, 5].map((i) => review({ id: `b${i}`, rating: i === 1 ? 1 : 4, date: `2026-10-0${i}T00:00:00Z` })));
    const w = await reviewMetricSource(root).window("app-store", "1", "2026-10-01", "2026-10-08");
    expect(w?.values).toEqual({ rating: 3.4, low_ratings: 0.2 });
    expect(await reviewMetricSource(root).window("app-store", "1", "2026-10-01", "2026-10-03")).toBeNull();
  });
});

describe("competitors", () => {
  it("keeps the listing, the best ranks and where it ranks for your targets", async () => {
    const { api, calls } = fakeApi({
      "/apps/999/keywords": () => ({ keywords: [{ keyword: "white noise", rank: 3, popularity: 70 }, { keyword: "fan sounds", rank: 12, popularity: 40, trend: "improving" }, { keyword: "x", rank: null }] }),
      "/apps/999/reviews": () => ({ reviews: [{ rating: 1, title: "Ads", content: "Too many ads" }, { rating: 5, title: "Love", content: "" }] }),
      "/apps/999": () => ({ title: "Calm Night", developer: "Calm Co", averageUserRating: 4.666, userRatingCount: 1200, metadata: { version: "2.0", currentVersionReleaseDate: "2026-10-30T00:00:00Z", releaseNotes: "New sounds" } }),
    });
    const c = await fetchCompetitorStore(api, "app-store", "999", "us", ["Fan Sounds", "rain"]);
    expect(c).toMatchObject({ id: "999", title: "Calm Night", rating: 4.67, ratings: 1200, version: "2.0", updated: "2026-10-30" });
    expect(c.ranks.map((r) => r.keyword)).toEqual(["white noise", "fan sounds"]);
    expect(c.yourTargets).toEqual([{ keyword: "fan sounds", rank: 12 }]);
    expect(c.recentReviews).toEqual({ count: 2, average: 3, low: [{ rating: 1, text: "Ads. Too many ads" }] });
    expect(calls.every((x) => x.url.searchParams.get("platform") === "apple" && x.url.searchParams.get("country") === "us")).toBe(true);
  });

  it("is listed in appeeky.spec.yaml by store id", () => {
    const spec = specFileSchema.parse({ version: 1, app: { name: "S" }, competitors: [{ name: "Calm", appStore: "999" }] });
    expect(spec.competitors).toEqual([{ name: "Calm", appStore: "999" }]);
    expect(() => specFileSchema.parse({ version: 1, app: { name: "S" }, competitors: [{ name: "Calm" }] })).toThrow();
  });
});

describe("data pull", () => {
  it("splits long ranges for the API", () => {
    expect(dateChunks("2026-01-01", "2026-12-31")).toEqual([["2026-01-01", "2026-06-29"], ["2026-06-30", "2026-12-26"], ["2026-12-27", "2026-12-31"]]);
  });

  it("merges a CSV by key and quotes what needs it", async () => {
    const dir = tmp();
    const base = { name: "x", about: "", key: ["date"], columns: ["date", "v", "note"] };
    await mergeCsv(dir, { ...base, rows: [{ date: "2026-10-01", v: 1 }, { date: "2026-10-02", v: 2, note: 'a, "b"' }] });
    const r = await mergeCsv(dir, { ...base, rows: [{ date: "2026-10-02", v: 3 }, { date: "2026-10-03", v: 4 }] });
    expect(r).toMatchObject({ rows: 3, from: "2026-10-01", to: "2026-10-03" });
    expect(readFileSync(join(dir, "x.csv"), "utf8")).toBe("date,v,note\n2026-10-01,1,\n2026-10-02,3,\n2026-10-03,4,\n");
  });

  it("writes every connected source to .appeeky/data/ with an index", async () => {
    const root = tmp();
    const spec = specFileSchema.parse({ version: 1, app: { name: "S" }, stores: { appStore: { appId: "123" } }, ads: { meta: { campaigns: ["m1"] } } });
    const project = { root, spec, listings: { "app-store": {}, "google-play": {} } } as Project;
    const { api } = fakeApi({
      "/user/apps/123/metrics": () => ({
        store: { source: "app-store-connect", days: [{ date: "2026-11-02", impressions: 900, pageViews: 300, downloads: 30, conversionRate: 0.1, proceeds: 12.5, trials: 2, subscriptions: 1 }] },
        sources: [{ source: "App Store search", impressions: 800, pageViews: 250, share: 0.83 }],
        ads: { currency: "USD", days: [{ date: "2026-11-02", spend: 20, impressions: 1000, taps: 50, installs: 10 }] },
        revenuecat: { scope: "app", currency: "USD", days: [{ date: "2026-11-02", revenue: 40, mrr: 900, trials: 3, newCustomers: 5, trialConversion: 0.3, churn: 0.02, actives: 120 }] },
      }),
      "/connect/metrics/apps/123": () => ({ daily: [{ metric_date: "2026-11-02", downloads: 31, revenue: 12, subscriptions: 1, trials: 2, iap_count: 4 }], countries: [{ country: "US", downloads: 20, revenue: 9 }] }),
      "/connect/meta-ads/insights": (q) => ({ data: [{ date_start: "2026-11-02", spend: "15", impressions: "3000", clicks: "60", actions: [{ action_type: "mobile_app_install", value: "6" }] }], echo: q.get("timeIncrement") }),
    });
    const result = await pullData(api, project, 3, new Date("2026-11-04T12:00:00Z"));
    expect(result.errors).toEqual([]);
    expect(result.files.map((f) => f.name).sort()).toEqual(["app-store-analytics", "app-store-countries", "app-store-sales", "app-store-traffic-sources", "apple-search-ads", "meta-ads", "revenuecat"]);
    const dir = join(root, ".appeeky", "data");
    expect(readFileSync(join(dir, "meta-ads.csv"), "utf8")).toBe("date,campaign,spend,impressions,clicks,installs\n2026-11-02,m1,15,3000,60,6\n");
    expect(readFileSync(join(dir, "app-store-analytics.csv"), "utf8").split("\n")[1]).toBe("2026-11-02,900,300,30,0.1,12.5,2,1");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("| revenuecat.csv | 1 | 2026-11-02 → 2026-11-02 |");
  });

  it("writes to appeeky/data/ when the spec commits it", async () => {
    const root = tmp();
    const spec = specFileSchema.parse({ version: 1, app: { name: "S" }, stores: { appStore: { appId: "123" } }, data: { commit: true } });
    const { api } = fakeApi({ "/user/apps/123/metrics": () => ({ store: { source: "app-store-connect", days: [{ date: "2026-11-02", downloads: 1 }] }, sources: null, ads: null, revenuecat: null }) });
    const result = await pullData(api, { root, spec, listings: { "app-store": {}, "google-play": {} } } as Project, 2, new Date("2026-11-04T00:00:00Z"));
    expect(result.files[0]!.path).toBe(join(root, "appeeky", "data", "app-store-analytics.csv"));
    expect(result.errors.map((e) => e.source)).toEqual(["App Store Connect sales"]);
  });
});

describe("words users use", () => {
  const review = (id: string, rating: number, body: string) => ({ id, store: "app-store" as const, rating, body, date: "2026-11-01T00:00:00Z" });
  it("finds phrases that come up in reviews and are missing from the listing", async () => {
    const { reviewPhrases } = await import("./reviews.js");
    const reviews = [
      review("1", 2, "I wish it had fan sounds for summer"),
      review("2", 3, "Need fan sounds please, also a sleep timer"),
      review("3", 4, "Great rain, add fan sounds"),
      review("4", 5, "The rain sounds help my baby sleep"),
      review("5", 5, "Rain sounds are perfect"),
      review("6", 1, "Sleep timer stops early"),
    ];
    const phrases = reviewPhrases(reviews, "Sleep Sounds: Rain, White Noise & Baby Sleep Aid");
    expect(phrases[0]).toEqual({ phrase: "fan sounds", reviews: 3, low: 2 });
    // "rain sounds" is in the listing's words, "sleep timer" only in two reviews.
    expect(phrases.map((p) => p.phrase)).not.toContain("rain sounds");
    expect(phrases.map((p) => p.phrase)).not.toContain("sleep timer");
  });
});
