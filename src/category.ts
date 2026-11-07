import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppeekyApi } from "./appeeky-api.js";
import { mergeCsv } from "./data.js";
import { SPEC_DIR } from "./files.js";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { Chart, Project, StoreId } from "./schema.js";
import { rankAppIds } from "./verify.js";

/**
 * The app's rank in its category chart, one row per day, store and storefront in
 * appeeky/category.csv. Ranks are public, so the file is committed with the spec
 * and `verify` reads it as the `category_rank` metric.
 *
 * App Store charts come from Apple's public RSS (no key). Google Play charts come
 * through the Appeeky API (APPEEKY_API_KEY).
 */

/** Charts list the top 100 apps; an app below that is "not in the chart". */
export const CHART_SIZE = 100;

export const categoryFile = (root: string) => join(root, SPEC_DIR, "category.csv");

export interface CategoryRank {
  date: string;
  /** Category name for people; not written to the file. */
  name?: string;
  store: StoreId;
  country: string;
  chart: Chart;
  category: string;
  /** null = not in the top 100. */
  rank: number | null;
}

export interface ChartSource {
  readonly label: string;
  /** App ids in chart order, best first, or null when the chart could not be read. */
  chart(store: StoreId, category: string, country: string, chart: Chart): Promise<string[] | null>;
}

const RSS_FEED: Record<Chart, string> = {
  "top-free": "topfreeapplications",
  "top-paid": "toppaidapplications",
  "top-grossing": "topgrossingapplications",
};

/** Apple's public category charts: the real per-genre chart, not the overall one filtered. */
export function appleChartSource(fetcher: typeof fetch = fetch): ChartSource {
  return {
    label: "App Store charts",
    async chart(store, category, country, chart) {
      if (store !== "app-store") return null;
      const url = `https://itunes.apple.com/${encodeURIComponent(country)}/rss/${RSS_FEED[chart]}/limit=${CHART_SIZE}/genre=${encodeURIComponent(category)}/json`;
      const res = await fetcher(url, { headers: { "User-Agent": "appeeky-spec" } });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as { feed?: { entry?: AppleEntry | AppleEntry[] } } | null;
      if (!json?.feed) return null;
      const entries = json.feed.entry === undefined ? [] : Array.isArray(json.feed.entry) ? json.feed.entry : [json.feed.entry];
      return entries.map((e) => e.id?.attributes?.["im:id"]).filter((id): id is string => Boolean(id));
    },
  };
}

interface AppleEntry {
  id?: { attributes?: { "im:id"?: string } };
}

/** Google Play category charts through the Appeeky API. */
export function playChartSource(api: AppeekyApi): ChartSource {
  return {
    label: "Google Play charts (Appeeky API)",
    async chart(store, category, country, chart) {
      if (store !== "google-play") return null;
      const data = await api.get<{ apps?: Array<{ appId: string; rank: number }>; total?: number }>(`/categories/${encodeURIComponent(category)}/top`, {
        platform: "google",
        country,
        chart,
        limit: String(CHART_SIZE),
      });
      const apps = data?.apps ?? [];
      // The API answers an empty list when it could not read the chart: unknown, not "unranked".
      if (apps.length === 0) return null;
      return [...apps].sort((a, b) => a.rank - b.rank).map((a) => a.appId);
    },
  };
}

/** Both stores: Apple's RSS for the App Store, the Appeeky API for Google Play when there is a key. */
export function chartSources(api: AppeekyApi | undefined, fetcher: typeof fetch = fetch): ChartSource {
  const apple = appleChartSource(fetcher);
  const play = api ? playChartSource(api) : undefined;
  return {
    label: [apple.label, play?.label].filter(Boolean).join(" + "),
    chart: (store, category, country, chart) => (store === "app-store" ? apple.chart(store, category, country, chart) : play ? play.chart(store, category, country, chart) : Promise.resolve(null)),
  };
}

/** The App Store app's genre and whether it is paid, from Apple's public lookup. */
export async function appleAppInfo(appId: string, country: string, fetcher: typeof fetch = fetch): Promise<{ genreId: string; genre: string; paid: boolean } | null> {
  const res = await fetcher(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`, { headers: { "User-Agent": "appeeky-spec" } });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as { results?: Array<{ primaryGenreId?: number; primaryGenreName?: string; price?: number }> } | null;
  const app = json?.results?.[0];
  if (!app?.primaryGenreId) return null;
  return { genreId: String(app.primaryGenreId), genre: app.primaryGenreName ?? String(app.primaryGenreId), paid: (app.price ?? 0) > 0 };
}

export interface CategoryPlan {
  store: StoreId;
  appId: string;
  category: string;
  chart: Chart;
  countries: string[];
  /** Category name for people, e.g. "Health & Fitness". */
  name?: string;
}

/** Which charts to read: the configured category, or the App Store app's own genre. */
export async function categoryPlans(project: Project, fetcher: typeof fetch = fetch): Promise<{ plans: CategoryPlan[]; notes: string[] }> {
  const cfg = project.spec.category ?? {};
  const ids = rankAppIds(project);
  const countries = cfg.countries ?? (Object.keys(project.spec.targets).length ? Object.keys(project.spec.targets) : ["us"]);
  const plans: CategoryPlan[] = [];
  const notes: string[] = [];
  if (ids["app-store"]) {
    let category = cfg.appStore;
    let chart = cfg.chart;
    const info = await appleAppInfo(ids["app-store"], countries[0]!, fetcher).catch(() => null);
    category ??= info?.genreId;
    chart ??= info?.paid ? "top-paid" : "top-free";
    const name = info && info.genreId === category ? info.genre : undefined;
    if (category) plans.push({ store: "app-store", appId: ids["app-store"], category, chart, countries, ...(name ? { name } : {}) });
    else notes.push("App Store: could not read the app's genre. Set category.appStore in appeeky.spec.yaml (e.g. 6013).");
  } else if (project.spec.stores.appStore) {
    notes.push("App Store: category charts need the numeric appId in stores.appStore.");
  }
  if (ids["google-play"]) {
    if (cfg.googlePlay) plans.push({ store: "google-play", appId: ids["google-play"], category: cfg.googlePlay, chart: cfg.chart ?? "top-free", countries, name: cfg.googlePlay.toLowerCase().replace(/_/g, " ") });
    else notes.push("Google Play: set category.googlePlay in appeeky.spec.yaml (e.g. HEALTH_AND_FITNESS) to record its chart.");
  }
  return { plans, notes };
}

/** Read every planned chart once and find the app in it. Charts that cannot be read are left out. */
export async function readCategoryRanks(plans: CategoryPlan[], source: ChartSource, now = new Date()): Promise<{ ranks: CategoryRank[]; failed: string[] }> {
  const date = now.toISOString().slice(0, 10);
  const ranks: CategoryRank[] = [];
  const failed: string[] = [];
  for (const p of plans) {
    for (const country of p.countries) {
      try {
        const ids = await source.chart(p.store, p.category, country, p.chart);
        if (!ids) {
          failed.push(`${p.store} ${country.toUpperCase()}: chart not available`);
          continue;
        }
        const index = ids.indexOf(p.appId);
        ranks.push({ date, store: p.store, country, chart: p.chart, category: p.category, rank: index >= 0 ? index + 1 : null, ...(p.name ? { name: p.name } : {}) });
      } catch (e) {
        failed.push(`${p.store} ${country.toUpperCase()}: ${(e as Error).message}`);
      }
    }
  }
  return { ranks, failed };
}

const COLUMNS = ["date", "store", "country", "chart", "category", "rank"];

export async function readCategoryHistory(root: string): Promise<CategoryRank[]> {
  const file = categoryFile(root);
  if (!existsSync(file)) return [];
  const [head, ...lines] = (await readFile(file, "utf8")).trim().split("\n");
  if (!head) return [];
  const cols = head.split(",");
  return lines.map((line) => {
    const v = Object.fromEntries(line.split(",").map((x, i) => [cols[i], x]));
    return {
      date: v.date ?? "",
      store: v.store as StoreId,
      country: v.country ?? "",
      chart: v.chart as Chart,
      category: v.category ?? "",
      rank: v.rank ? Number(v.rank) : null,
    };
  });
}

/** Add today's ranks to appeeky/category.csv (one row per day, store, storefront and chart). */
export async function saveCategoryRanks(root: string, ranks: CategoryRank[]): Promise<string> {
  const { path } = await mergeCsv(join(root, SPEC_DIR), {
    name: "category",
    about: "Rank in the category chart",
    key: ["date", "store", "country", "chart"],
    columns: COLUMNS,
    rows: ranks.map((r) => ({ ...r, rank: r.rank ?? "" })),
  });
  return path;
}

/** The latest row before `date` for the same store, storefront and chart. */
export function previousRank(history: CategoryRank[], r: CategoryRank): CategoryRank | undefined {
  return history
    .filter((h) => h.store === r.store && h.country === r.country && h.chart === r.chart && h.date < r.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}

/** Not in the chart counts as just past its end, so "out → out" is no move. */
const asRank = (r: number | null) => r ?? CHART_SIZE + 1;

/**
 * `category_rank` from the recorded history: the average rank over the days in
 * the window, across the recorded storefronts. Needs two recorded days.
 */
export function categoryMetricSource(root: string): MetricSource {
  let history: Promise<CategoryRank[]> | undefined;
  return {
    label: "Category charts in the repo",
    async window(store, _appId, from, to) {
      history ??= readCategoryHistory(root);
      const rows = (await history).filter((h) => h.store === store && h.date >= from && h.date < to);
      if (new Set(rows.map((r) => r.date)).size < 2) return null;
      // Every storefront out of the chart the whole time says nothing.
      if (rows.every((r) => r.rank === null)) return null;
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
      const values: MetricWindow["values"] = { category_rank: rows.reduce((n, r) => n + asRank(r.rank), 0) / rows.length };
      return { from, to, days, values };
    },
  };
}
