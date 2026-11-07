import { LIMITS } from "./limits.js";
import type { AppStoreListing, GooglePlayListing, Project, StoreId } from "./schema.js";
import { charLength, isEnglish, keywordEntries, singular, unique, words } from "./text.js";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  /** Stable rule id, e.g. `limit`, `keywords/duplicate-of-name`. */
  rule: string;
  store: StoreId;
  locale: string;
  field?: string;
  message: string;
}

/** Words Apple already ignores or that buy nothing in the keyword field. */
const APPLE_FILLER = new Set(["app", "apps", "the", "a", "an", "and", "or", "for", "with", "of", "iphone", "ipad"]);

/** Google Play's metadata policy rejects these in the title. */
const PLAY_TITLE_BANNED = [/\bbest\b/i, /#\s?1\b/, /\btop\b/i, /\bfree\b/i, /\bno\.?\s?1\b/i, /\bsale\b/i, /\bdiscount\b/i];

export function lintLength(store: StoreId, locale: string, field: string, value: string | undefined): Issue[] {
  const limit = LIMITS[store][field];
  if (!limit || value === undefined) return [];
  const used = charLength(value);
  if (used <= limit.max) return [];
  return [
    {
      severity: "error",
      rule: "limit",
      store,
      locale,
      field,
      message: `${field} is ${used}/${limit.max} characters; the store rejects it.`,
    },
  ];
}

export function lintAppStore(locale: string, listing: AppStoreListing): Issue[] {
  const issues: Issue[] = [];
  const at = (severity: Severity, rule: string, field: string, message: string) =>
    issues.push({ severity, rule, store: "app-store", locale, field, message });

  for (const [field, value] of Object.entries(listing)) {
    issues.push(...lintLength("app-store", locale, field, value as string | undefined));
  }

  const nameWords = new Set(words(listing.name));
  const subtitleWords = words(listing.subtitle);

  const repeatedInSubtitle = unique(subtitleWords.filter((w) => nameWords.has(w)));
  if (repeatedInSubtitle.length > 0) {
    at(
      "warning",
      "subtitle/repeats-name",
      "subtitle",
      `Subtitle repeats ${quoteList(repeatedInSubtitle)} from the name. Each word is indexed once, so use the space for a new word.`,
    );
  }

  if (listing.keywords !== undefined) {
    const field = listing.keywords;
    if (/,\s+|\s+,/.test(field)) {
      at("warning", "keywords/spaces", "keywords", "Spaces around commas waste characters in the keyword field. Write `a,b,c`.");
    }

    const entries = keywordEntries(field);
    if (entries.length === 1 && words(entries[0]).length >= 4) {
      at(
        "warning",
        "keywords/no-commas",
        "keywords",
        "The keyword field has no commas, so it reads as one long phrase. Separate keywords with commas: `a,b,c`.",
      );
    }
    const seen = new Map<string, number>();
    for (const entry of entries) seen.set(entry.toLowerCase(), (seen.get(entry.toLowerCase()) ?? 0) + 1);
    const repeated = [...seen].filter(([, n]) => n > 1).map(([e]) => e);
    if (repeated.length > 0) {
      at("warning", "keywords/duplicate", "keywords", `The keyword field lists ${quoteList(repeated)} more than once.`);
    }

    const keywordWords = entries.flatMap((e) => words(e));
    const titled = new Set([...nameWords, ...subtitleWords]);
    const alreadyIndexed = unique(keywordWords.filter((w) => titled.has(w)));
    if (alreadyIndexed.length > 0) {
      at(
        "warning",
        "keywords/duplicate-of-name",
        "keywords",
        `${quoteList(alreadyIndexed)} already ${alreadyIndexed.length === 1 ? "appears" : "appear"} in the name or subtitle, so the keyword field does not need ${alreadyIndexed.length === 1 ? "it" : "them"}.`,
      );
    }

    const repeatedWords = unique(keywordWords.filter((w, i) => keywordWords.indexOf(w) !== i));
    if (repeatedWords.length > 0) {
      at(
        "info",
        "keywords/repeated-word",
        "keywords",
        `${quoteList(repeatedWords)} ${repeatedWords.length === 1 ? "is" : "are"} written more than once. Single words combine with each other, so phrases rarely need repeating.`,
      );
    }

    if (isEnglish(locale)) {
      const filler = unique(keywordWords.filter((w) => APPLE_FILLER.has(w)));
      if (filler.length > 0) {
        at("info", "keywords/filler", "keywords", `${quoteList(filler)} add little in the keyword field.`);
      }
      const all = unique([...titled, ...keywordWords]);
      const plurals = all.filter((w) => singular(w) !== w && all.includes(singular(w)));
      if (plurals.length > 0) {
        at(
          "info",
          "keywords/plural-pair",
          "keywords",
          `Both singular and plural forms are used (${quoteList(plurals.map((p) => `${singular(p)}/${p}`))}). One form is often enough.`,
        );
      }
    }

    const spare = 100 - charLength(field);
    if (spare >= 10) {
      at("info", "keywords/unused-space", "keywords", `${spare} characters of the keyword field are unused.`);
    }
  }

  if (listing.name !== undefined && listing.name.trim() === "") at("error", "required", "name", "The name cannot be empty.");
  return issues;
}

export function lintGooglePlay(locale: string, listing: GooglePlayListing): Issue[] {
  const issues: Issue[] = [];
  for (const [field, value] of Object.entries(listing)) {
    issues.push(...lintLength("google-play", locale, field, value as string | undefined));
  }
  if (listing.title !== undefined) {
    const banned = PLAY_TITLE_BANNED.filter((re) => re.test(listing.title!)).map((re) => listing.title!.match(re)![0]);
    if (banned.length > 0) {
      issues.push({
        severity: "warning",
        rule: "play/title-policy",
        store: "google-play",
        locale,
        field: "title",
        message: `Google Play's metadata policy does not allow ranking or promotional words such as ${quoteList(banned)} in the title (fine only when part of your brand).`,
      });
    }
    if (/\p{Extended_Pictographic}/u.test(listing.title)) {
      issues.push({
        severity: "error",
        rule: "play/title-emoji",
        store: "google-play",
        locale,
        field: "title",
        message: "Google Play does not allow emoji in the title.",
      });
    }
    const letters = listing.title.replace(/[^\p{L}]/gu, "");
    if (letters.length >= 6 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
      issues.push({
        severity: "warning",
        rule: "play/title-caps",
        store: "google-play",
        locale,
        field: "title",
        message: "An all-caps title is against Google Play's metadata policy unless it is your brand.",
      });
    }
  }
  return issues;
}

export function lintProject(project: Project): Issue[] {
  const issues: Issue[] = [];
  for (const [locale, listing] of Object.entries(project.listings["app-store"])) issues.push(...lintAppStore(locale, listing));
  for (const [locale, listing] of Object.entries(project.listings["google-play"])) issues.push(...lintGooglePlay(locale, listing));

  if (project.spec.stores.appStore && Object.keys(project.listings["app-store"]).length === 0) {
    issues.push({
      severity: "info",
      rule: "listings/empty",
      store: "app-store",
      locale: "*",
      message: "No App Store listings yet. Run `appeeky-spec pull` to start from the live store.",
    });
  }
  if (project.spec.stores.googlePlay && Object.keys(project.listings["google-play"]).length === 0) {
    issues.push({
      severity: "info",
      rule: "listings/empty",
      store: "google-play",
      locale: "*",
      message: "No Google Play listings yet. Run `appeeky-spec pull` to start from the live store.",
    });
  }
  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

function quoteList(items: string[]): string {
  const quoted = items.map((i) => `"${i}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}
