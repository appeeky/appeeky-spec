import type { Project, StoreId } from "./schema.js";
import { indexedLocales, playLanguageFor } from "./storefronts.js";
import { keyWords, keywordEntries, normalize, words } from "./text.js";

/**
 * How well the listing covers a target search, strongest first.
 * - `title`: the exact phrase is in the name (App Store) or title (Google Play)
 * - `subtitle`: every word is in the name or subtitle (App Store)
 * - `short`: every word is in the short description (Google Play)
 * - `full`: every word is indexed somewhere in one locale
 * - `split`: every word is indexed, but across different locales (App Store; may not combine)
 * - `partial`: some words are indexed
 * - `none`: no word is indexed
 */
export type CoverageLevel = "title" | "subtitle" | "short" | "full" | "split" | "partial" | "none";

export interface KeywordCoverage {
  keyword: string;
  level: CoverageLevel;
  /** Locale that gives the best level. */
  locale?: string;
  /** Words of the keyword the listing does not index. */
  missing: string[];
  /** 0–100 search popularity from the Appeeky API, when fetched. */
  popularity?: number;
  difficulty?: number;
}

export interface StorefrontCoverage {
  store: StoreId;
  country: string;
  locales: string[];
  keywords: KeywordCoverage[];
  covered: number;
  total: number;
  /** Share of targets fully indexed (title, subtitle, short or full), 0–100. */
  percent: number;
  /** Same share weighted by popularity, when popularity is known for every target. */
  weightedPercent?: number;
}

const RANK: Record<CoverageLevel, number> = { title: 6, subtitle: 5, short: 5, full: 4, split: 2, partial: 1, none: 0 };
const COVERED = new Set<CoverageLevel>(["title", "subtitle", "short", "full"]);

export function isCovered(level: CoverageLevel): boolean {
  return COVERED.has(level);
}

function containsPhrase(haystack: string[], phrase: string[]): boolean {
  if (phrase.length === 0) return false;
  outer: for (let i = 0; i + phrase.length <= haystack.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (haystack[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

interface Scored {
  level: CoverageLevel;
  missing: string[];
}

function scoreAppStoreLocale(keyword: string[], listing: { name?: string; subtitle?: string; keywords?: string }): Scored {
  const name = words(listing.name);
  const titled = new Set([...name, ...words(listing.subtitle)]);
  const all = new Set([...titled, ...keywordEntries(listing.keywords).flatMap((e) => words(e))]);
  const missing = keyword.filter((w) => !all.has(w));
  if (containsPhrase(name, keyword)) return { level: "title", missing: [] };
  if (keyword.every((w) => titled.has(w))) return { level: "subtitle", missing: [] };
  if (missing.length === 0) return { level: "full", missing };
  if (missing.length < keyword.length) return { level: "partial", missing };
  return { level: "none", missing };
}

function scoreGooglePlay(keyword: string[], listing: { title?: string; shortDescription?: string; fullDescription?: string }): Scored {
  const title = words(listing.title);
  const short = new Set(words(listing.shortDescription));
  const all = new Set([...title, ...short, ...words(listing.fullDescription)]);
  const missing = keyword.filter((w) => !all.has(w));
  if (containsPhrase(title, keyword)) return { level: "title", missing: [] };
  if (keyword.every((w) => short.has(w) || title.includes(w))) return { level: "short", missing: [] };
  if (missing.length === 0) return { level: "full", missing };
  if (missing.length < keyword.length) return { level: "partial", missing };
  return { level: "none", missing };
}

export type PopularityLookup = (keyword: string, country: string, store: StoreId) => { popularity?: number; difficulty?: number } | undefined;

function summarize(
  store: StoreId,
  country: string,
  locales: string[],
  keywords: KeywordCoverage[],
): StorefrontCoverage {
  const covered = keywords.filter((k) => isCovered(k.level)).length;
  const total = keywords.length;
  const result: StorefrontCoverage = {
    store,
    country,
    locales,
    keywords,
    covered,
    total,
    percent: total === 0 ? 0 : Math.round((covered / total) * 100),
  };
  if (total > 0 && keywords.every((k) => typeof k.popularity === "number")) {
    const weight = keywords.reduce((s, k) => s + Math.max(k.popularity!, 1), 0);
    const hit = keywords.filter((k) => isCovered(k.level)).reduce((s, k) => s + Math.max(k.popularity!, 1), 0);
    result.weightedPercent = Math.round((hit / weight) * 100);
  }
  return result;
}

/** App Store coverage of one storefront's targets across the locales that storefront indexes. */
export function appStoreCoverage(project: Project, country: string, lookup?: PopularityLookup): StorefrontCoverage {
  const locales = indexedLocales(project, country);
  const targets = project.spec.targets[country] ?? [];
  const keywords = targets.map((raw): KeywordCoverage => {
    const kw = keyWords(raw);
    let best: Scored & { locale?: string } = { level: "none", missing: kw };
    const union = new Set<string>();
    for (const locale of locales) {
      const listing = project.listings["app-store"][locale] ?? {};
      const scored = scoreAppStoreLocale(kw, listing);
      kw.filter((w) => !scored.missing.includes(w)).forEach((w) => union.add(w));
      if (RANK[scored.level] > RANK[best.level] || (RANK[scored.level] === RANK[best.level] && scored.missing.length < best.missing.length)) {
        best = { ...scored, locale };
      }
    }
    if (!isCovered(best.level) && kw.length > 0 && kw.every((w) => union.has(w))) {
      best = { level: "split", missing: [], locale: undefined };
    }
    return { keyword: normalize(raw).trim(), level: best.level, locale: best.locale, missing: best.missing, ...lookup?.(raw, country, "app-store") };
  });
  return summarize("app-store", country, locales, keywords);
}

/** Google Play coverage of one storefront's targets in the language that storefront most likely shows. */
export function googlePlayCoverage(project: Project, country: string, lookup?: PopularityLookup): StorefrontCoverage {
  const language = playLanguageFor(project, country);
  const listing = language ? (project.listings["google-play"][language] ?? {}) : {};
  const targets = project.spec.targets[country] ?? [];
  const keywords = targets.map((raw): KeywordCoverage => {
    const scored = scoreGooglePlay(keyWords(raw), listing);
    return { keyword: normalize(raw).trim(), level: scored.level, locale: language, missing: scored.missing, ...lookup?.(raw, country, "google-play") };
  });
  return summarize("google-play", country, language ? [language] : [], keywords);
}

/** Coverage for every storefront with targets, for each store the spec ships to. */
export function projectCoverage(project: Project, lookup?: PopularityLookup): StorefrontCoverage[] {
  const out: StorefrontCoverage[] = [];
  for (const country of Object.keys(project.spec.targets)) {
    if (project.spec.stores.appStore && Object.keys(project.listings["app-store"]).length > 0) {
      out.push(appStoreCoverage(project, country, lookup));
    }
    if (project.spec.stores.googlePlay && Object.keys(project.listings["google-play"]).length > 0) {
      out.push(googlePlayCoverage(project, country, lookup));
    }
  }
  return out;
}
