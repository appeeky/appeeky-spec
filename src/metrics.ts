import type { StoreId } from "./schema.js";

/**
 * Business outcomes of a change, beyond search ranks: conversion, downloads,
 * revenue, trials and paid installs. They come from the store analytics,
 * Apple Search Ads and RevenueCat data a user has connected in Appeeky
 * (`GET /v1/user/apps/:appId/metrics`), so they need APPEEKY_API_KEY.
 */
export const METRICS = {
  conversion: { label: "conversion", kind: "rate", better: "up" },
  page_views: { label: "page views/day", kind: "count", better: "up" },
  downloads: { label: "downloads/day", kind: "count", better: "up" },
  proceeds: { label: "proceeds/day", kind: "money", better: "up" },
  trials: { label: "trials/day", kind: "count", better: "up" },
  revenue: { label: "revenue/day", kind: "money", better: "up" },
  rc_trials: { label: "RevenueCat trials/day", kind: "count", better: "up" },
  trial_conversion: { label: "trial conversion", kind: "rate", better: "up" },
  ad_installs: { label: "ad installs/day", kind: "count", better: "up" },
  cpa: { label: "cost per ad install", kind: "money", better: "down" },
  rating: { label: "average rating", kind: "count", better: "up" },
  organic_installs: { label: "organic installs/day", kind: "count", better: "up" },
  organic_revenue: { label: "organic revenue/day", kind: "money", better: "up" },
  organic_paid: { label: "organic installs that paid", kind: "rate", better: "up" },
  link_clicks: { label: "clicks on the experiment's link", kind: "count", better: "up" },
  link_installs: { label: "installs from the experiment's link", kind: "count", better: "up" },
  link_revenue: { label: "revenue from the experiment's link", kind: "money", better: "up" },
  low_ratings: { label: "1–2 star reviews", kind: "rate", better: "down" },
  meta_spend: { label: "Meta spend/day", kind: "money", better: "down" },
  meta_installs: { label: "Meta installs/day", kind: "count", better: "up" },
  meta_cpi: { label: "Meta cost per install", kind: "money", better: "down" },
  tiktok_spend: { label: "TikTok spend/day", kind: "money", better: "down" },
  tiktok_conversions: { label: "TikTok conversions/day", kind: "count", better: "up" },
  tiktok_cpa: { label: "TikTok cost per conversion", kind: "money", better: "down" },
  ai_visibility: { label: "AI answers that name the app", kind: "rate", better: "up" },
  category_rank: { label: "category rank", kind: "count", better: "down" },
} as const satisfies Record<string, { label: string; kind: "rate" | "count" | "money"; better: "up" | "down" }>;

export type MetricName = keyof typeof METRICS;

export function isMetricName(name: string): name is MetricName {
  return name in METRICS;
}

/** Metric values over a date range: counts and money per day, rates over the whole range. */
export interface MetricWindow {
  from: string;
  /** Exclusive end. */
  to: string;
  days: number;
  values: Partial<Record<MetricName, number>>;
  currency?: string;
}

/** Where outcome metrics come from. */
export interface MetricSource {
  readonly label: string;
  /** Metrics between two ISO dates (inclusive start, exclusive end); null when there is no data. */
  window(store: StoreId, appId: string, from: string, to: string): Promise<MetricWindow | null>;
}

/** The part of the Appeeky API response this module reads. */
export interface AppMetricsResponse {
  store: { days: Array<{ date: string; pageViews: number | null; downloads: number | null; proceeds: number | null; trials: number | null }> } | null;
  ads: { currency: string | null; days: Array<{ date: string; spend: number; installs: number }> } | null;
  revenuecat: {
    scope: "app" | "project";
    currency: string | null;
    days: Array<{ date: string; revenue: number | null; trials: number | null; trialConversion: number | null }>;
  } | null;
}

/** Below this many product page views in a window, a conversion rate is noise. */
export const MIN_PAGE_VIEWS = 50;

const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((n, x) => n + (x ?? 0), 0);
const known = <T>(xs: Array<T | null | undefined>): T[] => xs.filter((x): x is T => x !== null && x !== undefined);

/**
 * Sum one API response into a window. RevenueCat numbers are only used when
 * the RevenueCat project holds just this app; project-wide numbers would
 * credit a listing change with another app's revenue.
 */
export function summarizeMetrics(data: AppMetricsResponse, from: string, to: string): MetricWindow {
  const values: MetricWindow["values"] = {};
  const store = data.store?.days ?? [];
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
  if (store.length > 0) {
    const pageViews = sum(store.map((d) => d.pageViews));
    const downloads = sum(store.map((d) => d.downloads));
    if (known(store.map((d) => d.pageViews)).length) values.page_views = pageViews / days;
    if (known(store.map((d) => d.downloads)).length) values.downloads = downloads / days;
    if (pageViews >= MIN_PAGE_VIEWS) values.conversion = downloads / pageViews;
    if (known(store.map((d) => d.proceeds)).length) values.proceeds = sum(store.map((d) => d.proceeds)) / days;
    if (known(store.map((d) => d.trials)).length) values.trials = sum(store.map((d) => d.trials)) / days;
  }
  const ads = data.ads?.days ?? [];
  if (ads.length > 0) {
    const installs = sum(ads.map((d) => d.installs));
    values.ad_installs = installs / days;
    if (installs > 0) values.cpa = sum(ads.map((d) => d.spend)) / installs;
  }
  const rc = data.revenuecat?.scope === "app" ? data.revenuecat.days : [];
  if (rc.length > 0) {
    if (known(rc.map((d) => d.revenue)).length) values.revenue = sum(rc.map((d) => d.revenue)) / days;
    if (known(rc.map((d) => d.trials)).length) values.rc_trials = sum(rc.map((d) => d.trials)) / days;
    const tc = known(rc.map((d) => d.trialConversion));
    if (tc.length) values.trial_conversion = tc.reduce((a, b) => a + b, 0) / tc.length;
  }
  const currency = data.revenuecat?.currency ?? data.ads?.currency ?? undefined;
  return { from, to, days, values, ...(currency ? { currency } : {}) };
}

export interface MetricChange {
  metric: MetricName;
  before: number;
  after: number;
  /** Relative change, e.g. 0.12 = +12%. */
  change: number;
  /** Whether the move is good for the app, given which direction is better. */
  outcome: "better" | "worse" | "flat";
  /**
   * How much this metric normally moves between two windows of the same length before the
   * change (twice the spread of past window-to-window changes). A change inside it is flat.
   */
  noise?: number;
}

/** Changes smaller than this are noise. */
export const FLAT_WITHIN = 0.05;

export function outcomeOf(metric: MetricName, change: number, noise = 0): MetricChange["outcome"] {
  if (Math.abs(change) < Math.max(FLAT_WITHIN, noise)) return "flat";
  const up = change > 0;
  return METRICS[metric].better === "up" ? (up ? "better" : "worse") : up ? "worse" : "better";
}

/**
 * What a listing change is for: more people finding the app and paying. Organic numbers
 * (from attribution) come first; without them, store conversion, then downloads, then
 * the category rank (public, so it is there even without connected analytics).
 */
const LISTING_OUTCOMES: MetricName[][] = [["organic_installs", "organic_revenue"], ["conversion"], ["downloads"], ["category_rank"]];

/**
 * A verdict from outcomes, for a release whose ranks did not move (or that has no
 * targets): won when the listing outcomes got better, lost when worse.
 */
export function outcomeVerdict(changes: MetricChange[]): { verdict: "won" | "lost" | "mixed" | "flat"; by: MetricName[] } | null {
  for (const group of LISTING_OUTCOMES) {
    const found = changes.filter((c) => group.includes(c.metric));
    if (found.length === 0) continue;
    const better = found.filter((c) => c.outcome === "better").length;
    const worse = found.filter((c) => c.outcome === "worse").length;
    const verdict = better && !worse ? "won" : worse && !better ? "lost" : better && worse ? "mixed" : "flat";
    return { verdict, by: found.map((c) => c.metric) };
  }
  return null;
}

/** Every metric present in both windows, with a usable before value. */
export function compareWindows(before: MetricWindow, after: MetricWindow, noise: Partial<Record<MetricName, number>> = {}): MetricChange[] {
  const out: MetricChange[] = [];
  for (const metric of Object.keys(METRICS) as MetricName[]) {
    const b = before.values[metric];
    const a = after.values[metric];
    if (b === undefined || a === undefined || b <= 0) continue;
    const change = a / b - 1;
    const band = noise[metric];
    out.push({ metric, before: b, after: a, change, outcome: outcomeOf(metric, change, band), ...(band !== undefined ? { noise: band } : {}) });
  }
  return out;
}

/** Past windows used to learn how much each metric moves on its own. */
export const NOISE_WINDOWS = 4;

/**
 * Twice the spread of window-to-window changes over consecutive past windows, per metric:
 * roughly the range a metric moves in with nothing changed. Needs three or more changes.
 */
export function noiseBands(windows: MetricWindow[]): Partial<Record<MetricName, number>> {
  const out: Partial<Record<MetricName, number>> = {};
  for (const metric of Object.keys(METRICS) as MetricName[]) {
    const changes: number[] = [];
    for (let i = 1; i < windows.length; i++) {
      const b = windows[i - 1]!.values[metric];
      const a = windows[i]!.values[metric];
      if (b !== undefined && a !== undefined && b > 0) changes.push(a / b - 1);
    }
    if (changes.length < 3) continue;
    const mean = changes.reduce((s, x) => s + x, 0) / changes.length;
    const sd = Math.sqrt(changes.reduce((s, x) => s + (x - mean) ** 2, 0) / (changes.length - 1));
    out[metric] = Math.round(2 * sd * 1000) / 1000;
  }
  return out;
}

/** One Meta insights row (Graph API shape: numbers come as strings). */
export interface MetaInsightRow {
  spend?: string | number;
  actions?: Array<{ action_type: string; value: string | number }>;
}

/** Meta counts an app install under one of these action types, depending on how the campaign is set up. */
const META_INSTALL_ACTIONS = ["mobile_app_install", "app_install", "omni_app_install"];

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Spend and installs of the given Meta campaigns' insights rows, per day. */
export function summarizeMeta(rows: MetaInsightRow[], days: number): MetricWindow["values"] {
  if (rows.length === 0) return {};
  const spend = rows.reduce((n, r) => n + num(r.spend), 0);
  const installs = rows.reduce((n, r) => {
    const actions = r.actions ?? [];
    // Take the first install type present so one install is not counted twice.
    const type = META_INSTALL_ACTIONS.find((t) => actions.some((a) => a.action_type === t));
    return n + (type ? num(actions.find((a) => a.action_type === type)?.value) : 0);
  }, 0);
  const values: MetricWindow["values"] = { meta_spend: spend / days, meta_installs: installs / days };
  if (installs > 0) values.meta_cpi = spend / installs;
  return values;
}

/** One TikTok integrated report row. */
export interface TikTokReportRow {
  dimensions?: { campaign_id?: string };
  metrics?: { spend?: string | number; conversion?: string | number };
}

/** Spend and conversions of the given TikTok campaigns, per day. Rows for other campaigns are left out. */
export function summarizeTikTok(rows: TikTokReportRow[], campaigns: string[], days: number): MetricWindow["values"] {
  const mine = rows.filter((r) => r.dimensions?.campaign_id && campaigns.includes(String(r.dimensions.campaign_id)));
  if (mine.length === 0) return {};
  const spend = mine.reduce((n, r) => n + num(r.metrics?.spend), 0);
  const conversions = mine.reduce((n, r) => n + num(r.metrics?.conversion), 0);
  const values: MetricWindow["values"] = { tiktok_spend: spend / days, tiktok_conversions: conversions / days };
  if (conversions > 0) values.tiktok_cpa = spend / conversions;
  return values;
}

/**
 * Several sources as one: each window merges the values every source has.
 * A source that fails or has no data is skipped, so one broken connection
 * does not hide the others.
 */
export function combineSources(sources: MetricSource[]): MetricSource {
  return {
    label: sources.map((s) => s.label).join(", "),
    async window(store, appId, from, to) {
      const windows = await Promise.all(sources.map((s) => s.window(store, appId, from, to).catch(() => null)));
      const found = windows.filter((w): w is MetricWindow => w !== null);
      if (found.length === 0) return null;
      const currency = found.find((w) => w.currency)?.currency;
      return {
        from,
        to,
        days: found[0]!.days,
        values: Object.assign({}, ...found.map((w) => w.values)),
        ...(currency ? { currency } : {}),
      };
    },
  };
}

export interface MetricsCheck {
  source: string;
  before: MetricWindow;
  after: MetricWindow;
  changes: MetricChange[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Compare the `days` before a moment (a push, an experiment start) with the `days` after it. */
export async function measureAround(source: MetricSource, store: StoreId, appId: string, at: string, days: number): Promise<MetricsCheck | null> {
  const t = Date.parse(at);
  const span = Math.max(1, days) * 86_400_000;
  // The day of the change itself is mixed, so it is in neither window.
  const before = await source.window(store, appId, iso(t - span), iso(t));
  const after = await source.window(store, appId, iso(t + 86_400_000), iso(t + 86_400_000 + span));
  if (!before || !after) return null;
  // The windows before `before`, oldest first, to learn each metric's usual move.
  const past: MetricWindow[] = [];
  for (let k = NOISE_WINDOWS; k >= 1; k--) {
    const w = await source.window(store, appId, iso(t - (k + 1) * span), iso(t - k * span)).catch(() => null);
    if (w) past.push(w);
  }
  const changes = compareWindows(before, after, noiseBands([...past, before]));
  return changes.length > 0 ? { source: source.label, before, after, changes } : null;
}

/** One metric's average over the `days` before a moment, for an experiment baseline. */
export async function metricBefore(source: MetricSource, store: StoreId, appId: string, metric: MetricName, at: string, days: number): Promise<number | undefined> {
  const t = Date.parse(at);
  const window = await source.window(store, appId, iso(t - Math.max(1, days) * 86_400_000), iso(t));
  return window?.values[metric];
}

/** One metric's average over the `days` from a moment on, for an experiment result. */
export async function metricAfter(source: MetricSource, store: StoreId, appId: string, metric: MetricName, at: string, days: number): Promise<number | undefined> {
  const t = Date.parse(at);
  const window = await source.window(store, appId, iso(t), iso(t + Math.max(1, days) * 86_400_000));
  return window?.values[metric];
}

/** "conversion 3.1% → 3.6% (+16%)", "revenue/day $41.20 → $47.90 (+16%)" */
export function formatChange(c: MetricChange, currency?: string): string {
  const { kind, label } = METRICS[c.metric];
  const fmt = (v: number) =>
    kind === "rate" ? `${(v * 100).toFixed(1)}%` : kind === "money" ? `${currency && currency !== "USD" ? `${currency} ` : "$"}${v.toFixed(2)}` : v >= 10 ? v.toFixed(0) : v.toFixed(1);
  const pct = `${c.change >= 0 ? "+" : ""}${(c.change * 100).toFixed(0)}%`;
  return `${label} ${fmt(c.before)} → ${fmt(c.after)} (${pct})`;
}
