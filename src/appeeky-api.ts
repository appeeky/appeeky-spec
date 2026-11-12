import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PopularityLookup } from "./coverage.js";
import type { RankSource } from "./verify.js";
import {
  combineSources,
  summarizeMeta,
  summarizeMetrics,
  summarizeTikTok,
  type AppMetricsResponse,
  type MetaInsightRow,
  type MetricSource,
  type TikTokReportRow,
} from "./metrics.js";
import type { SpecFile, StoreId } from "./schema.js";
import { normalize } from "./text.js";

export const APPEEKY_API_URL = "https://api.appeeky.com/v1";

export interface KeywordMetric {
  popularity: number;
  difficulty: number;
  fetchedAt: string;
}

type Fetcher = typeof fetch;

/** An error answer from the Appeeky API, with its HTTP status and error code, so callers can tell "not there" from "failed". */
export class AppeekyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AppeekyApiError";
  }
}

type ErrorBody = { error?: { message?: string; code?: string } } | null;

/**
 * Small client for the Appeeky API (market data for ASO). Needs an API key
 * from appeeky.com; every command that uses it also works without it.
 */
export class AppeekyApi {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    options: { baseUrl?: string; fetcher?: Fetcher } = {},
  ) {
    this.base = (options.baseUrl ?? APPEEKY_API_URL).replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  private readonly fetcher: Fetcher;

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await this.fetcher(url, { headers: { "X-API-Key": this.apiKey, "User-Agent": "appeeky-spec" } });
    const body = (await res.json().catch(() => null)) as ({ data?: T } & ErrorBody) | null;
    if (!res.ok) {
      const retry = res.headers.get("retry-after");
      throw new AppeekyApiError(`Appeeky API ${path}: ${body?.error?.message ?? `HTTP ${res.status}`}${retry ? ` (retry after ${retry}s)` : ""}`, res.status, body?.error?.code);
    }
    return body?.data as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetcher(this.base + path, {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json", "User-Agent": "appeeky-spec" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as ({ data?: T } & ErrorBody) | null;
    if (!res.ok) throw new AppeekyApiError(`Appeeky API ${path}: ${json?.error?.message ?? `HTTP ${res.status}`}`, res.status, json?.error?.code);
    return json?.data as T;
  }

  /** Any other method, e.g. DELETE. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(this.base + path, {
      method,
      headers: { "X-API-Key": this.apiKey, "User-Agent": "appeeky-spec", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as ({ data?: T } & ErrorBody) | null;
    if (!res.ok) throw new AppeekyApiError(`Appeeky API ${path}: ${json?.error?.message ?? `HTTP ${res.status}`}`, res.status, json?.error?.code);
    return json?.data as T;
  }

  /** Keyword opportunities for an app: popular searches it does not rank for yet. */
  async opportunities(appId: string, country: string, store: StoreId): Promise<Array<{ keyword: string; popularity: number; difficulty: number | null; source?: string }>> {
    const data = await this.get<{ opportunities?: Array<{ keyword: string; volumeScore: number; difficulty: number | null; isBrandTerm?: boolean; source?: string }> }>(
      `/aso/opportunities/${encodeURIComponent(appId)}`,
      { country, platform: store === "app-store" ? "apple" : "google" },
    );
    return (data?.opportunities ?? [])
      .filter((o) => !o.isBrandTerm)
      .map((o) => ({ keyword: o.keyword, popularity: o.volumeScore, difficulty: o.difficulty, source: o.source }));
  }

  /** Popularity (0–100) and difficulty for one keyword in several storefronts. */
  async keywordMetrics(keyword: string, countries: string[], store: StoreId): Promise<Record<string, KeywordMetric>> {
    const data = await this.get<{ results?: Record<string, { volumeScore?: number; difficulty?: number }> }>("/keywords/metrics", {
      keyword,
      countries: countries.join(","),
      platform: store === "app-store" ? "apple" : "google",
    });
    const now = new Date().toISOString();
    const out: Record<string, KeywordMetric> = {};
    for (const [cc, m] of Object.entries(data?.results ?? {})) {
      out[cc] = { popularity: m.volumeScore ?? 0, difficulty: m.difficulty ?? 0, fetchedAt: now };
    }
    return out;
  }
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface MetricsCache {
  [key: string]: KeywordMetric;
}

function cacheKey(store: StoreId, country: string, keyword: string): string {
  return `${store}:${country}:${normalize(keyword).trim()}`;
}

/**
 * Fetch popularity for every target keyword, reusing a 7-day cache in
 * `.appeeky/cache/metrics.json` so repeated runs stay inside the API's
 * per-minute limit. Returns a lookup for the coverage report.
 */
export async function loadPopularity(
  root: string,
  api: AppeekyApi | undefined,
  targets: Record<string, string[]>,
  stores: StoreId[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ lookup: PopularityLookup; fetched: number; failed: string[] }> {
  const file = join(root, ".appeeky", "cache", "metrics.json");
  let cache: MetricsCache = {};
  if (existsSync(file)) {
    try {
      cache = JSON.parse(await readFile(file, "utf8")) as MetricsCache;
    } catch {
      cache = {};
    }
  }
  const fresh = (m: KeywordMetric | undefined) => m && Date.now() - Date.parse(m.fetchedAt) < CACHE_TTL_MS;

  // One request per keyword covers every storefront that targets it.
  const byKeyword = new Map<string, Set<string>>();
  for (const [country, keywords] of Object.entries(targets)) {
    for (const k of keywords) {
      const key = normalize(k).trim();
      if (!byKeyword.has(key)) byKeyword.set(key, new Set());
      byKeyword.get(key)!.add(country);
    }
  }

  let fetched = 0;
  const failed: string[] = [];
  if (api) {
    const jobs: Array<{ store: StoreId; keyword: string; countries: string[] }> = [];
    for (const store of stores) {
      for (const [keyword, countries] of byKeyword) {
        const stale = [...countries].filter((cc) => !fresh(cache[cacheKey(store, cc, keyword)]));
        if (stale.length > 0) jobs.push({ store, keyword, countries: stale });
      }
    }
    for (const [i, job] of jobs.entries()) {
      // The API allows 10 metrics requests a minute per key; pace after the first burst.
      if (i >= 10) await new Promise((r) => setTimeout(r, 6_100));
      try {
        const metrics = await api.keywordMetrics(job.keyword, job.countries, job.store);
        for (const [cc, m] of Object.entries(metrics)) cache[cacheKey(job.store, cc, job.keyword)] = m;
        fetched++;
      } catch (err) {
        failed.push(`${job.keyword}: ${(err as Error).message}`);
        if (/retry after|burst|429/i.test((err as Error).message)) break;
      }
      onProgress?.(i + 1, jobs.length);
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache, null, 2));
  }

  const lookup: PopularityLookup = (keyword, country, store) => {
    const m = cache[cacheKey(store, country, keyword)];
    return m ? { popularity: m.popularity, difficulty: m.difficulty } : undefined;
  };
  return { lookup, fetched, failed };
}

/** Live ranks from the Appeeky API (App Store and Google Play), 10 keywords per request. */
export function appeekyRankSource(api: AppeekyApi): RankSource {
  return {
    label: "Appeeky API",
    async ranks(store, appId, country, keywords) {
      const out: Record<string, number | null> = {};
      for (let i = 0; i < keywords.length; i += 10) {
        const batch = keywords.slice(i, i + 10);
        const data = await api.post<{ results?: Array<{ keyword: string; rank: number | null }> }>(
          `/apps/${encodeURIComponent(appId)}/keywords/verify`,
          { keywords: batch, country, platform: store === "app-store" ? "apple" : "google" },
        );
        for (const r of data?.results ?? []) out[normalize(r.keyword).trim()] = r.rank ?? null;
      }
      return out;
    },
  };
}

/**
 * Outcome metrics (store analytics, Search Ads, RevenueCat) for an app in the
 * user's Appeeky list. Apps that are not in the list, or have nothing
 * connected, give null.
 */
export function appeekyMetricSource(api: AppeekyApi): MetricSource {
  return {
    label: "Appeeky (store analytics, Search Ads, RevenueCat)",
    async window(_store, appId, from, to) {
      // The API takes an inclusive last day; windows here end exclusively.
      const last = new Date(Date.parse(to) - 86_400_000).toISOString().slice(0, 10);
      try {
        const data = await api.get<AppMetricsResponse>(`/user/apps/${encodeURIComponent(appId)}/metrics`, { from, to: last });
        if (!data) return null;
        const window = summarizeMetrics(data, from, to);
        return Object.keys(window.values).length > 0 ? window : null;
      } catch (e) {
        if (/not found/i.test((e as Error).message)) return null;
        throw e;
      }
    },
  };
}

/** The window's inclusive last day; windows here end exclusively. */
const lastDay = (to: string) => new Date(Date.parse(to) - 86_400_000).toISOString().slice(0, 10);
const daysIn = (from: string, to: string) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

/** Spend and installs of the Meta campaigns listed under `ads.meta`, through the Meta connection in Appeeky. */
export function metaMetricSource(api: AppeekyApi, config: NonNullable<SpecFile["ads"]["meta"]>): MetricSource {
  return {
    label: "Meta Ads",
    async window(_store, _appId, from, to) {
      const rows: MetaInsightRow[] = [];
      for (const campaign of config.campaigns) {
        const data = await api.get<{ data?: MetaInsightRow[] }>("/connect/meta-ads/insights", {
          targetType: "campaign",
          targetId: campaign,
          since: from,
          until: lastDay(to),
          fields: "spend,actions",
          ...(config.adAccount ? { adAccountId: config.adAccount } : {}),
        });
        rows.push(...(data?.data ?? []));
      }
      const values = summarizeMeta(rows, daysIn(from, to));
      return Object.keys(values).length > 0 ? { from, to, days: daysIn(from, to), values } : null;
    },
  };
}

/** Spend and conversions of the TikTok campaigns listed under `ads.tiktok`, through the TikTok connection in Appeeky. */
export function tiktokMetricSource(api: AppeekyApi, config: NonNullable<SpecFile["ads"]["tiktok"]>): MetricSource {
  return {
    label: "TikTok Ads",
    async window(_store, _appId, from, to) {
      const data = await api.get<{ list?: TikTokReportRow[] }>("/connect/tiktok-ads/report", {
        dataLevel: "AUCTION_CAMPAIGN",
        dimensions: "campaign_id",
        metrics: "spend,conversion",
        startDate: from,
        endDate: lastDay(to),
        pageSize: "1000",
        ...(config.advertiser ? { advertiserId: config.advertiser } : {}),
      });
      const values = summarizeTikTok(data?.list ?? [], config.campaigns, daysIn(from, to));
      return Object.keys(values).length > 0 ? { from, to, days: daysIn(from, to), values } : null;
    },
  };
}

/** Every outcome source a spec can use: the app's connected data, plus the Meta and TikTok campaigns it lists. */
export function metricSourceFor(api: AppeekyApi, spec: SpecFile): MetricSource {
  const sources = [appeekyMetricSource(api)];
  if (spec.ads.meta) sources.push(metaMetricSource(api, spec.ads.meta));
  if (spec.ads.tiktok) sources.push(tiktokMetricSource(api, spec.ads.tiktok));
  return sources.length === 1 ? sources[0]! : combineSources(sources);
}
