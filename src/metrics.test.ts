import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appeekyMetricSource, AppeekyApi } from "./appeeky-api.js";
import { closeExperiment, experimentSchema, readExperiments, writeExperiment } from "./experiments.js";
import { loadProject, writeSpec } from "./files.js";
import { writeRelease, type ReleaseRecord } from "./history.js";
import { measureExperiments, playbookLine, verifyReleases } from "./measure.js";
import { compareWindows, formatChange, measureAround, outcomeVerdict, summarizeMetrics, type AppMetricsResponse, type MetricSource, type MetricWindow } from "./metrics.js";
import type { RankSource } from "./verify.js";

const response = (over: Partial<AppMetricsResponse> = {}): AppMetricsResponse => ({
  store: {
    days: [
      { date: "2026-10-01", pageViews: 100, downloads: 10, proceeds: 5, trials: 2 },
      { date: "2026-10-02", pageViews: 100, downloads: 20, proceeds: 15, trials: null },
    ],
  },
  ads: { currency: "USD", days: [{ date: "2026-10-01", spend: 30, installs: 10 }] },
  revenuecat: { scope: "app", currency: "USD", days: [{ date: "2026-10-01", revenue: 40, trials: 4, trialConversion: 0.3 }] },
  ...over,
});

describe("summarizeMetrics", () => {
  it("turns counts into per-day values and rates over the whole window", () => {
    const w = summarizeMetrics(response(), "2026-10-01", "2026-10-03");
    expect(w.days).toBe(2);
    expect(w.values).toMatchObject({ page_views: 100, downloads: 15, conversion: 0.15, proceeds: 10, trials: 1, ad_installs: 5, cpa: 3, revenue: 20, rc_trials: 2, trial_conversion: 0.3 });
    expect(w.currency).toBe("USD");
  });

  it("leaves out RevenueCat when its project also holds other apps", () => {
    const w = summarizeMetrics(response({ revenuecat: { scope: "project", currency: "USD", days: [{ date: "2026-10-01", revenue: 400, trials: 9, trialConversion: 0.2 }] } }), "2026-10-01", "2026-10-03");
    expect(w.values.revenue).toBeUndefined();
    expect(w.values.trial_conversion).toBeUndefined();
  });

  it("has no conversion without enough page views", () => {
    const w = summarizeMetrics({ store: { days: [{ date: "2026-10-01", pageViews: null, downloads: 4, proceeds: null, trials: null }] }, ads: null, revenuecat: null }, "2026-10-01", "2026-10-02");
    expect(w.values.conversion).toBeUndefined();
    const few = summarizeMetrics({ store: { days: [{ date: "2026-10-01", pageViews: 12, downloads: 4, proceeds: null, trials: null }] }, ads: null, revenuecat: null }, "2026-10-01", "2026-10-02");
    expect(few.values.conversion).toBeUndefined();
    expect(w.values.downloads).toBe(4);
  });
});

const win = (values: MetricWindow["values"]): MetricWindow => ({ from: "2026-10-01", to: "2026-10-08", days: 7, values });

describe("compareWindows", () => {
  it("judges each metric by the direction that is good for the app", () => {
    const changes = compareWindows(win({ conversion: 0.1, cpa: 2, downloads: 50 }), win({ conversion: 0.12, cpa: 2.5, downloads: 51 }));
    expect(changes.map((c) => [c.metric, c.outcome])).toEqual([
      ["conversion", "better"],
      ["downloads", "flat"],
      ["cpa", "worse"],
    ]);
  });

  it("skips metrics missing on either side", () => {
    expect(compareWindows(win({ revenue: 10 }), win({ conversion: 0.1 }))).toEqual([]);
  });

  it("formats rates, money and counts", () => {
    const [conv, money] = compareWindows(win({ conversion: 0.031, revenue: 41.2 }), win({ conversion: 0.036, revenue: 47.9 }));
    expect(formatChange(conv!)).toBe("conversion 3.1% → 3.6% (+16%)");
    expect(formatChange(money!, "EUR")).toBe("revenue/day EUR 41.20 → EUR 47.90 (+16%)");
  });
});

describe("measureAround", () => {
  it("compares the days before a moment with the days after it, skipping the day itself", async () => {
    const calls: string[] = [];
    const source: MetricSource = {
      label: "test",
      window: async (_s, _a, from, to) => {
        calls.push(`${from}..${to}`);
        return { from, to, days: 7, values: { conversion: from < "2026-10-10" ? 0.1 : 0.13 } };
      },
    };
    const check = await measureAround(source, "app-store", "42", "2026-10-10T09:00:00Z", 7);
    expect(calls.slice(0, 2)).toEqual(["2026-10-03..2026-10-10", "2026-10-11..2026-10-18"]);
    // Then four past windows, to learn how much conversion moves on its own.
    expect(calls.slice(2)).toEqual(["2026-09-05..2026-09-12", "2026-09-12..2026-09-19", "2026-09-19..2026-09-26", "2026-09-26..2026-10-03"]);
    expect(check!.changes[0]).toMatchObject({ metric: "conversion", outcome: "better", noise: 0 });
  });

  it("calls a change flat when the metric moves that much on its own", async () => {
    // Weekly downloads swing ±30% with nothing changed; +20% after the push is within that.
    const past: Record<string, number> = { "2026-09-05": 100, "2026-09-12": 135, "2026-09-19": 95, "2026-09-26": 130, "2026-10-03": 100 };
    const source: MetricSource = {
      label: "test",
      window: async (_s, _a, from, to) => ({ from, to, days: 7, values: { downloads: past[from] ?? 120 } }),
    };
    const check = await measureAround(source, "app-store", "42", "2026-10-10T09:00:00Z", 7);
    expect(check!.changes[0]).toMatchObject({ metric: "downloads", outcome: "flat" });
    expect(check!.changes[0]!.change).toBeCloseTo(0.2);
    expect(check!.changes[0]!.noise).toBeGreaterThan(0.5);
  });
});

describe("appeekyMetricSource", () => {
  it("asks the API for an inclusive range and summarizes it", async () => {
    let url = "";
    const fetcher = (async (u: URL) => {
      url = String(u);
      return new Response(JSON.stringify({ data: response() }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = appeekyMetricSource(new AppeekyApi("key", { baseUrl: "https://api.test/v1", fetcher }));
    const w = await source.window("app-store", "42", "2026-10-01", "2026-10-03");
    expect(url).toBe("https://api.test/v1/user/apps/42/metrics?from=2026-10-01&to=2026-10-02");
    expect(w!.values.conversion).toBe(0.15);
  });

  it("gives null for an app that is not in the user's list", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: { message: "App not found in your list." } }), { status: 404 })) as unknown as typeof fetch;
    const source = appeekyMetricSource(new AppeekyApi("key", { fetcher }));
    expect(await source.window("app-store", "42", "2026-10-01", "2026-10-03")).toBeNull();
  });
});

describe("experiments measured from metrics", () => {
  const base = experimentSchema.parse({ id: "x", type: "pricing", hypothesis: "Annual first", metric: "trial_conversion", baseline: 0.3, startedAt: "2026-10-01T00:00:00Z" });

  it("win or lose against the baseline when there is no target", () => {
    expect(closeExperiment(base, 0.36, undefined).status).toBe("won");
    expect(closeExperiment(base, 0.24, undefined).status).toBe("lost");
    expect(closeExperiment(base, 0.305, undefined).status).toBe("inconclusive");
  });

  it("treat a lower cost per install as the win", () => {
    const cpa = { ...base, metric: "cpa", baseline: 2 };
    expect(closeExperiment(cpa, 1.6, undefined).status).toBe("won");
    expect(closeExperiment({ ...cpa, target: 1.8 }, 1.9, undefined).status).toBe("lost");
  });

  it("are closed by verify once due", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-metrics-"));
    await writeSpec(root, { version: 1, app: { name: "Sleep" }, stores: { appStore: { appId: "42" } } });
    await writeExperiment(root, { ...base, id: "annual-first", startedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    await writeExperiment(root, { ...base, id: "hook-video", metric: "install_per_1k_views", startedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    const source: MetricSource = { label: "test", window: async (_s, _a, from, to) => ({ from, to, days: 14, values: { trial_conversion: 0.4 } }) };
    const closed = await measureExperiments(await loadProject(root), source);
    expect(closed.map((e) => [e.id, e.status, e.result?.value])).toEqual([["annual-first", "won", 0.4]]);
    const saved = await readExperiments(root);
    expect(saved.find((e) => e.id === "hook-video")!.status).toBe("running");
  });
});

describe("verify with metrics", () => {
  it("records conversion and revenue next to the ranks", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-metrics-"));
    await writeSpec(root, { version: 1, app: { name: "Sleep" }, stores: { appStore: { appId: "42" } }, targets: { us: ["rain"] } });
    const pushedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const release: ReleaseRecord = {
      id: "2026-10-23T10-00-00Z-app-store",
      pushedAt,
      store: "app-store",
      target: "version 2.4",
      via: "test",
      note: "Lead with rain",
      changes: [{ locale: "en-US", field: "subtitle", before: "Calm", after: "Rain & fan" }],
      baseline: { at: pushedAt, source: "test", ranks: { us: { rain: 30 } } },
    };
    await writeRelease(root, release);
    const ranks: RankSource = { label: "test", ranks: async () => ({ rain: 12 }) };
    const metrics: MetricSource = {
      label: "test",
      window: async (_s, _a, from, to) => ({
        from,
        to,
        days: 7,
        values: from < pushedAt.slice(0, 10) ? { conversion: 0.1, page_views: 100, revenue: 20 } : { conversion: 0.12, page_views: 110, revenue: 26 },
      }),
    };
    const [result] = await verifyReleases(await loadProject(root), ranks, { metrics });
    expect(result!.check.metrics!.changes.map((c) => [c.metric, c.outcome])).toEqual([
      ["conversion", "better"],
      ["page_views", "better"],
      ["revenue", "better"],
    ]);
    expect(result!.check.conversion).toMatchObject({ before: { rate: 0.1 }, after: { rate: 0.12 } });
    expect(playbookLine(result!)).toContain("conversion 10.0% → 12.0% (+20%); revenue/day $20.00 → $26.00 (+30%)");
    expect(readFileSync(join(root, "appeeky/releases", `${release.id}.yaml`), "utf8")).toContain("metrics:");
  });

  it("decides by organic installs when no rank moved", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-metrics-"));
    await writeSpec(root, { version: 1, app: { name: "Sleep" }, stores: { appStore: { appId: "42" } } });
    const pushedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await writeRelease(root, {
      id: "2026-10-23T10-00-00Z-app-store",
      pushedAt,
      store: "app-store",
      target: "version 2.4",
      via: "test",
      changes: [{ locale: "en-US", field: "subtitle", before: "Calm", after: "Rain & fan" }],
      baseline: { at: pushedAt, source: "test", ranks: {} },
    });
    const metrics: MetricSource = {
      label: "test",
      window: async (_s, _a, from, to) => ({
        from,
        to,
        days: 7,
        values: from < pushedAt ? { organic_installs: 10, organic_revenue: 12, downloads: 50 } : { organic_installs: 14, organic_revenue: 20, downloads: 45 },
      }),
    };
    const [result] = await verifyReleases(await loadProject(root), { label: "test", ranks: async () => ({}) }, { metrics });
    expect(result!.check).toMatchObject({ verdict: "won", decidedBy: ["organic_installs", "organic_revenue"] });
    expect(playbookLine(result!)).toContain("day 7 won by outcomes (organic installs/day 10 → 14 (+40%)");
  });
});

describe("outcomeVerdict", () => {
  const change = (metric: "organic_installs" | "conversion" | "downloads", outcome: "better" | "worse" | "flat") => ({ metric, before: 1, after: 1, change: 0, outcome });
  it("prefers organic numbers, then conversion, then downloads", () => {
    expect(outcomeVerdict([change("downloads", "better"), change("organic_installs", "worse")])).toEqual({ verdict: "lost", by: ["organic_installs"] });
    expect(outcomeVerdict([change("downloads", "worse"), change("conversion", "better")])).toEqual({ verdict: "won", by: ["conversion"] });
    expect(outcomeVerdict([change("downloads", "flat")])).toEqual({ verdict: "flat", by: ["downloads"] });
    expect(outcomeVerdict([])).toBeNull();
  });
});
