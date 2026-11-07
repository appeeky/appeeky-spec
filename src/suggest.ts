import { appStoreCoverage, googlePlayCoverage, isCovered } from "./coverage.js";
import type { Project, StoreId } from "./schema.js";
import { indexedLocales } from "./storefronts.js";
import { charLength, keywordEntries, STOPWORDS, unique, words } from "./text.js";

/** Add one word to an App Store keyword field the compact way (`a,b,c`), or return null when it does not fit. */
export function appendKeyword(field: string | undefined, word: string, maxChars = 100): string | null {
  const entries = keywordEntries(field);
  if (entries.some((e) => e.toLowerCase() === word.toLowerCase())) return entries.join(",");
  const next = [...entries, word].join(",");
  return charLength(next) <= maxChars ? next : null;
}

/** Words of the locale's indexed fields (App Store: name, subtitle, keyword field). */
function indexedWords(project: Project, locale: string): Set<string> {
  const l = project.listings["app-store"][locale] ?? {};
  return new Set([...words(l.name), ...words(l.subtitle), ...keywordEntries(l.keywords).flatMap((e) => words(e))]);
}

export interface KeywordSuggestion {
  word: string;
  /** Targets that this word would help cover. */
  helps: string[];
  popularity?: number;
  /** True when the word still fits in the keyword field. */
  fits: boolean;
  /** True when one of your own targets needs it (ranked before API candidates). */
  target: boolean;
}

export interface CandidateKeyword {
  keyword: string;
  popularity?: number;
  /** "suggestion" for store autocomplete ideas, which must relate to the listing to count. */
  source?: string;
}

/**
 * Words to add to one App Store locale's keyword field: the missing words of
 * targets in storefronts that index this locale, plus extra candidates (for
 * example keyword opportunities from the Appeeky API). Words already indexed
 * anywhere in the locale are left out.
 *
 * An autocomplete idea only counts when it shares a word with the listing or
 * the targets: "screenshot stitching" is an idea for a screenshot app, "proton
 * vpn" (another product the store's autocomplete returned) is not. Searches
 * the app already ranks for always count.
 */
export function keywordSuggestions(project: Project, locale: string, candidates: CandidateKeyword[] = []): KeywordSuggestion[] {
  const have = indexedWords(project, locale);
  const field = project.listings["app-store"][locale]?.keywords;
  const out = new Map<string, KeywordSuggestion>();
  const add = (word: string, helps: string, popularity: number | undefined, target: boolean) => {
    if (have.has(word) || word.length < 2 || STOPWORDS.has(word)) return;
    const s = out.get(word) ?? { word, helps: [], fits: appendKeyword(field, word) !== null, target };
    s.target ||= target;
    if (!s.helps.includes(helps)) s.helps.push(helps);
    if (popularity !== undefined) s.popularity = Math.max(s.popularity ?? 0, popularity);
    out.set(word, s);
  };

  for (const country of Object.keys(project.spec.targets)) {
    if (!indexedLocales(project, country).includes(locale)) continue;
    for (const k of appStoreCoverage(project, country).keywords) {
      if (!isCovered(k.level)) for (const w of k.missing) add(w, k.keyword, k.popularity, true);
    }
  }
  const related = new Set(
    [...have, ...Object.values(project.spec.targets).flatMap((list) => list.flatMap((t) => words(t)))].filter((w) => !STOPWORDS.has(w)),
  );
  for (const c of candidates) {
    const cw = words(c.keyword);
    if (c.source === "suggestion" && !cw.some((w) => related.has(w))) continue;
    for (const w of cw) add(w, c.keyword, c.popularity, false);
  }

  return [...out.values()].sort(
    (a, b) =>
      Number(b.fits) - Number(a.fits) ||
      Number(b.target) - Number(a.target) ||
      (b.popularity ?? 0) - (a.popularity ?? 0) ||
      b.helps.length - a.helps.length,
  );
}

export interface CrossLocalizationSuggestion {
  country: string;
  /** The secondary locale whose keyword field gets the words. */
  locale: string;
  add: string[];
  /** The keyword field after adding them. */
  keywords: string;
  /** The field was one long phrase without commas; `keywords` also splits it into words. */
  splitPhrase?: boolean;
}

/**
 * A keyword field written without commas reads as one long phrase. Split it
 * into comma-separated words so each word can combine with others.
 */
export function splitKeywordPhrase(field: string): string | null {
  const entries = keywordEntries(field);
  if (entries.length !== 1 || !/\s/.test(entries[0]!)) return null;
  return unique(words(entries[0])).join(",");
}

/**
 * Storefronts that index more than one locale (the US reads Spanish (Mexico)
 * too) get extra keyword space for free. Fill the spare characters of the secondary
 * locale with words the storefront's targets still miss.
 */
export function crossLocalizationSuggestions(project: Project): CrossLocalizationSuggestion[] {
  const out: CrossLocalizationSuggestion[] = [];
  for (const country of Object.keys(project.spec.targets)) {
    const present = indexedLocales(project, country);
    // The first locale is the storefront's own; the rest are extra keyword space.
    const secondary = present.slice(1);
    if (secondary.length === 0) continue;

    const covered = new Set(present.flatMap((l) => [...indexedWords(project, l)]));
    const missing = unique(
      appStoreCoverage(project, country)
        .keywords.filter((k) => !isCovered(k.level))
        .flatMap((k) => words(k.keyword))
        .filter((w) => !covered.has(w) && !STOPWORDS.has(w)),
    );
    for (const locale of secondary) {
      const original = project.listings["app-store"][locale]?.keywords ?? "";
      const split = splitKeywordPhrase(original);
      let field = split ?? original;
      const added: string[] = [];
      for (const w of missing) {
        if (out.some((s) => s.country === country && s.add.includes(w))) continue;
        const next = appendKeyword(field, w);
        if (next === null) continue;
        field = next;
        added.push(w);
      }
      if (added.length > 0) out.push({ country, locale, add: added, keywords: field, ...(split ? { splitPhrase: true } : {}) });
    }
  }
  return out;
}

/** A competitor metadata change, as recorded by Appeeky's competitor timeline. */
export interface CompetitorChange {
  competitor: string;
  field: string;
  before: string | null;
  after: string | null;
  at: string;
}

export interface CompetitorGap {
  competitor: string;
  field: string;
  at: string;
  /** Words the competitor stopped using that one of your targets needs. */
  dropped: string[];
  /** Words the competitor started using that one of your targets needs. */
  added: string[];
  /** Of the dropped words, those your listing does not index yet. */
  openings: string[];
}

/** Turn competitor metadata changes into openings for one storefront's targets. */
export function competitorGaps(project: Project, country: string, changes: CompetitorChange[], store: StoreId = "app-store"): CompetitorGap[] {
  const targetWords = new Set((project.spec.targets[country] ?? []).flatMap((k) => words(k)));
  if (targetWords.size === 0) return [];
  const report = store === "app-store" ? appStoreCoverage(project, country) : googlePlayCoverage(project, country);
  const missing = new Set(report.keywords.flatMap((k) => k.missing));
  const gaps: CompetitorGap[] = [];
  for (const ch of changes) {
    // A change with one side missing is not a change we can read words from.
    if (!ch.before || !ch.after) continue;
    const before = new Set(words(ch.before ?? ""));
    const after = new Set(words(ch.after ?? ""));
    const dropped = [...before].filter((w) => !after.has(w) && targetWords.has(w));
    const added = [...after].filter((w) => !before.has(w) && targetWords.has(w));
    if (dropped.length === 0 && added.length === 0) continue;
    gaps.push({ competitor: ch.competitor, field: ch.field, at: ch.at, dropped, added, openings: dropped.filter((w) => missing.has(w)) });
  }
  return gaps;
}
