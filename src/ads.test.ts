import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { adsSnapshot, saveAdsSnapshot } from "./ads.js";
import { AppeekyApi, metricSourceFor } from "./appeeky-api.js";
import { combineSources, summarizeMeta, summarizeTikTok, type MetricSource } from "./metrics.js";
import { specFileSchema } from "./schema.js";

const spec = (ads: unknown) => specFileSchema.parse({ version: 1, app: { name: "Sleep Sounds" }, stores: { appStore: { appId: "123" } }, ads });

/** A fake API: answers by path, records every request. */
function fakeApi(routes: Record<string, (q: URLSearchParams) => unknown>) {
  const calls: URL[] = [];
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = Object.keys(routes).find((p) => url.pathname.endsWith(p));
    if (!route) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    return new Response(JSON.stringify({ data: routes[route]!(url.searchParams) }), { status: 200 });
  }) as typeof fetch;
  return { api: new AppeekyApi("key", { baseUrl: "https://api.test/v1", fetcher }), calls };
}

describe("ads in appeeky.spec.yaml", () => {
  it("is optional and defaults to nothing", () => {
    expect(spec(undefined).ads).toEqual({});
  });

  it("needs at least one campaign per channel", () => {
    expect(() => spec({ meta: { campaigns: [] } })).toThrow();
    expect(spec({ tiktok: { advertiser: "7", campaigns: ["1"] } }).ads.tiktok).toEqual({ advertiser: "7", campaigns: ["1"] });
  });
});

describe("summarizeMeta", () => {
  it("adds spend and installs per day, and counts one install type only", () => {
    const v = summarizeMeta(
      [
        { spend: "20", actions: [{ action_type: "mobile_app_install", value: "8" }, { action_type: "omni_app_install", value: "8" }] },
        { spend: 10, actions: [{ action_type: "link_click", value: "40" }, { action_type: "app_install", value: "2" }] },
      ],
      2,
    );
    expect(v).toEqual({ meta_spend: 15, meta_installs: 5, meta_cpi: 3 });
  });

  it("has no cost per install without installs", () => {
    expect(summarizeMeta([{ spend: "9", actions: [] }], 3)).toEqual({ meta_spend: 3, meta_installs: 0 });
    expect(summarizeMeta([], 3)).toEqual({});
  });
});

describe("summarizeTikTok", () => {
  it("keeps only the listed campaigns", () => {
    const rows = [
      { dimensions: { campaign_id: "1" }, metrics: { spend: "30", conversion: "6" } },
      { dimensions: { campaign_id: "2" }, metrics: { spend: "999", conversion: "1" } },
    ];
    expect(summarizeTikTok(rows, ["1"], 3)).toEqual({ tiktok_spend: 10, tiktok_conversions: 2, tiktok_cpa: 5 });
    expect(summarizeTikTok(rows, ["3"], 3)).toEqual({});
  });
});

describe("combineSources", () => {
  const source = (label: string, values: Record<string, number> | Error | null): MetricSource => ({
    label,
    async window(_s, _a, from, to) {
      if (values instanceof Error) throw values;
      return values ? { from, to, days: 7, values } : null;
    },
  });

  it("merges every source that has data and skips the ones that fail", async () => {
    const both = combineSources([source("a", { downloads: 10 }), source("b", new Error("down")), source("c", { meta_spend: 4 })]);
    expect((await both.window("app-store", "1", "2026-10-01", "2026-10-08"))?.values).toEqual({ downloads: 10, meta_spend: 4 });
  });

  it("is null when no source has data", async () => {
    expect(await combineSources([source("a", null)]).window("app-store", "1", "2026-10-01", "2026-10-08")).toBeNull();
  });
});

describe("Meta and TikTok sources", () => {
  it("asks for each Meta campaign and the TikTok report over the window's days", async () => {
    const { api, calls } = fakeApi({
      "/metrics": () => ({ store: null, ads: { currency: "USD", days: [{ date: "2026-10-01", spend: 14, installs: 7 }] }, revenuecat: null }),
      "/connect/meta-ads/insights": (q) => ({ data: [{ spend: q.get("targetId") === "m1" ? "7" : "7", actions: [{ action_type: "mobile_app_install", value: "7" }] }] }),
      "/connect/tiktok-ads/report": () => ({ list: [{ dimensions: { campaign_id: "t1" }, metrics: { spend: "21", conversion: "3" } }] }),
    });
    const s = spec({ meta: { campaigns: ["m1", "m2"], adAccount: "act_9" }, tiktok: { advertiser: "adv", campaigns: ["t1"] } });
    const w = await metricSourceFor(api, s).window("app-store", "123", "2026-10-01", "2026-10-08");
    expect(w?.values).toMatchObject({ ad_installs: 1, cpa: 2, meta_spend: 2, meta_installs: 2, meta_cpi: 1, tiktok_spend: 3, tiktok_conversions: 3 / 7, tiktok_cpa: 7 });

    const meta = calls.filter((u) => u.pathname.endsWith("/insights"));
    expect(meta.map((u) => u.searchParams.get("targetId"))).toEqual(["m1", "m2"]);
    expect(meta[0]!.searchParams.get("since")).toBe("2026-10-01");
    expect(meta[0]!.searchParams.get("until")).toBe("2026-10-07");
    expect(meta[0]!.searchParams.get("adAccountId")).toBe("act_9");
    const tiktok = calls.find((u) => u.pathname.endsWith("/report"))!;
    expect(tiktok.searchParams.get("advertiserId")).toBe("adv");
    expect(tiktok.searchParams.get("endDate")).toBe("2026-10-07");
  });
});

describe("adsSnapshot", () => {
  it("reports each channel and keeps going when one fails", async () => {
    const { api } = fakeApi({
      "/metrics": () => ({ store: null, ads: { currency: "USD", days: [{ date: "2026-10-01", spend: 60, installs: 30 }] }, revenuecat: null }),
      "/connect/meta-ads/insights": () => ({ data: [{ spend: "30", actions: [{ action_type: "mobile_app_install", value: "10" }] }] }),
    });
    const s = spec({ meta: { campaigns: ["m1"] }, tiktok: { campaigns: ["t1"] } });
    const snap = await adsSnapshot(api, s, { store: "app-store", appId: "123" }, 30, new Date("2026-11-04T12:00:00Z"));
    expect(snap.from).toBe("2026-10-05");
    expect(snap.to).toBe("2026-11-04");
    expect(snap.channels).toEqual([
      { channel: "apple-search-ads", spendPerDay: 2, resultsPerDay: 1, costPerResult: 2, result: "installs" },
      { channel: "meta", spendPerDay: 1, resultsPerDay: 0.33, costPerResult: 3, result: "installs" },
    ]);
    expect(snap.errors.map((e) => e.channel)).toEqual(["tiktok"]);

    const root = mkdtempSync(join(tmpdir(), "spec-ads-"));
    const file = await saveAdsSnapshot(root, snap);
    expect(file).toBe(join(root, "appeeky", "ads", "2026-11-04.yaml"));
    const saved = YAML.parse(readFileSync(file, "utf8"));
    expect(saved.channels).toHaveLength(2);
    expect(saved.errors).toBeUndefined();
  });
});
