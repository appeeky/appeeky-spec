import type { Project, StoreId } from "./schema.js";
import { normalize } from "./text.js";

/** Where a store app's search rank for a keyword comes from. `null` = not in the results. */
export interface RankSource {
  readonly label: string;
  /** Ranks for several keywords in one storefront. Missing keys mean "unknown". */
  ranks(store: StoreId, appId: string, country: string, keywords: string[]): Promise<Record<string, number | null>>;
}

/** country → keyword → rank */
export type RankSnapshot = Record<string, Record<string, number | null>>;

export interface RankBaseline {
  at: string;
  source: string;
  ranks: Partial<Record<StoreId, RankSnapshot>>;
}

/** Store ids for rank lookups: numeric App Store id, Google Play package name. */
export function rankAppIds(project: Project): Partial<Record<StoreId, string>> {
  const ids: Partial<Record<StoreId, string>> = {};
  const asc = project.spec.stores.appStore?.appId;
  if (asc && /^\d+$/.test(asc)) ids["app-store"] = asc;
  if (project.spec.stores.googlePlay) ids["google-play"] = project.spec.stores.googlePlay.packageName;
  return ids;
}

/** Ranks for every target of the given stores; failures leave that storefront out. */
export async function snapshotRanks(project: Project, source: RankSource, stores: StoreId[]): Promise<RankBaseline> {
  const ids = rankAppIds(project);
  const baseline: RankBaseline = { at: new Date().toISOString(), source: source.label, ranks: {} };
  for (const store of stores) {
    const appId = ids[store];
    if (!appId) continue;
    const snap: RankSnapshot = {};
    for (const [country, targets] of Object.entries(project.spec.targets)) {
      const keywords = [...new Set(targets.map((k) => normalize(k).trim()))];
      if (keywords.length === 0) continue;
      try {
        snap[country] = await source.ranks(store, appId, country, keywords);
      } catch {
        // A storefront that cannot be read now is simply not part of the baseline.
      }
    }
    if (Object.keys(snap).length > 0) baseline.ranks[store] = snap;
  }
  return baseline;
}

export interface RankMove {
  country: string;
  keyword: string;
  before: number | null;
  after: number | null;
}

export type Verdict = "won" | "lost" | "mixed" | "flat";

export interface RankEvaluation {
  improved: RankMove[];
  dropped: RankMove[];
  /** Top-20 terms that fell out of the top 20 by 10+ places, or stopped ranking. */
  regressions: RankMove[];
  verdict: Verdict;
  /** Set when ranks did not move and the verdict came from these outcome metrics instead. */
  decidedBy?: string[];
  /** The changed storefronts against the unchanged ones over the same days. */
  control?: import("./control.js").ControlComparison;
  /** Why the verdict differs from the raw rank count, in words. */
  note?: string;
}

/** A move only counts when it is at least this many places. */
const MIN_MOVE = 3;
/** Same thresholds as the co-founder's ranking-term guard and auto-revert. */
const TOP = 20;
const DROP_PLACES = 10;

/** Not ranked counts as just past the 200 results the stores return, so "out → out" is no move. */
const UNRANKED = 201;
const asRank = (r: number | null | undefined) => (r === null || r === undefined ? UNRANKED : r);

/**
 * Compare two snapshots of one store. A release "lost" when one top-10 term
 * or two top-20 terms fell away (the rule the co-founder uses to propose a
 * revert), "won" when more terms rose than fell, "mixed" or "flat" otherwise.
 */
export function evaluateRanks(before: RankSnapshot, after: RankSnapshot): RankEvaluation {
  const improved: RankMove[] = [];
  const dropped: RankMove[] = [];
  const regressions: RankMove[] = [];
  for (const [country, ranks] of Object.entries(before)) {
    for (const [keyword, b] of Object.entries(ranks)) {
      if (!(keyword in (after[country] ?? {}))) continue;
      const a = after[country]![keyword] ?? null;
      const move = { country, keyword, before: b, after: a };
      const from = asRank(b);
      const to = asRank(a);
      if (to + MIN_MOVE <= from) improved.push(move);
      else if (from + MIN_MOVE <= to) dropped.push(move);
      if (b !== null && b <= TOP && (a === null || (a > TOP && a - b >= DROP_PLACES))) regressions.push(move);
    }
  }
  const lost = regressions.length >= 2 || regressions.some((r) => (r.before ?? UNRANKED) <= 10);
  const verdict: Verdict = lost
    ? "lost"
    : improved.length > dropped.length
      ? "won"
      : improved.length === 0 && dropped.length === 0
        ? "flat"
        : "mixed";
  return { improved, dropped, regressions, verdict };
}

/** App Store ranks from Apple's public search API: no key needed, top 200 results. */
export function itunesRankSource(fetcher: typeof fetch = fetch): RankSource {
  return {
    label: "App Store search",
    async ranks(store, appId, country, keywords) {
      if (store !== "app-store") return {};
      const out: Record<string, number | null> = {};
      for (const keyword of keywords) {
        const url = `https://itunes.apple.com/search?media=software&entity=software&limit=200&country=${encodeURIComponent(country)}&term=${encodeURIComponent(keyword)}`;
        const res = await fetcher(url, { headers: { "User-Agent": "appeeky-spec" } });
        if (!res.ok) continue;
        const json = (await res.json()) as { results?: Array<{ trackId?: number }> };
        const index = (json.results ?? []).findIndex((r) => String(r.trackId) === appId);
        out[keyword] = index >= 0 ? index + 1 : null;
      }
      return out;
    },
  };
}

/** Combine sources: the first one that knows a keyword wins. */
export function firstRankSource(...sources: RankSource[]): RankSource {
  return {
    label: sources.map((s) => s.label).join(" + "),
    async ranks(store, appId, country, keywords) {
      const out: Record<string, number | null> = {};
      let left = keywords;
      for (const s of sources) {
        if (left.length === 0) break;
        try {
          Object.assign(out, await s.ranks(store, appId, country, left));
        } catch {
          // try the next source
        }
        left = keywords.filter((k) => !(k in out));
      }
      return out;
    },
  };
}

/** Store-listing conversion over a date range, e.g. installs / product page visitors. */
export interface ConversionWindow {
  /** installs ÷ visitors, 0–1 */
  rate: number;
  visitors: number;
  installs: number;
  days: number;
}

/** Where conversion numbers come from (App Store Connect analytics, Play Console, a local cache). */
export interface ConversionSource {
  readonly label: string;
  /** Conversion between two ISO dates (inclusive start, exclusive end); null when there is no data. */
  conversion(store: StoreId, appId: string, from: string, to: string): Promise<ConversionWindow | null>;
}

export interface ConversionChange {
  before: ConversionWindow;
  after: ConversionWindow;
  /** Relative change of the rate, e.g. 0.12 = +12%. */
  change: number;
}

/** Compare the conversion of the `days` before a push with the `days` after it. */
export async function measureConversion(
  source: ConversionSource,
  store: StoreId,
  appId: string,
  pushedAt: string,
  days: number,
): Promise<ConversionChange | null> {
  const t = Date.parse(pushedAt);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const span = Math.max(1, days) * 86_400_000;
  const before = await source.conversion(store, appId, iso(t - span), iso(t));
  const after = await source.conversion(store, appId, iso(t + 86_400_000), iso(t + 86_400_000 + span));
  if (!before || !after || before.visitors === 0 || after.visitors === 0) return null;
  return { before, after, change: before.rate > 0 ? after.rate / before.rate - 1 : 0 };
}
