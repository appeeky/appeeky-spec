import type { Project } from "./schema.js";

/**
 * Listing locales each App Store storefront is commonly observed to index, in
 * order of preference. Apple does not publish this list and it changes, so it
 * is a starting point: override any storefront with `storefronts:` in
 * `appeeky.spec.yaml`. Storefronts not listed here fall back to the app's
 * primary locale.
 */
export const DEFAULT_STOREFRONT_LOCALES: Record<string, string[]> = {
  us: ["en-US", "es-MX"],
  gb: ["en-GB"],
  ca: ["en-CA", "fr-CA"],
  au: ["en-AU"],
  nz: ["en-AU", "en-GB"],
  ie: ["en-GB"],
  in: ["en-GB", "hi"],
  de: ["de-DE"],
  at: ["de-DE"],
  ch: ["de-DE", "fr-FR", "it"],
  fr: ["fr-FR"],
  be: ["fr-FR", "nl-NL"],
  nl: ["nl-NL"],
  es: ["es-ES"],
  mx: ["es-MX"],
  ar: ["es-MX"],
  co: ["es-MX"],
  cl: ["es-MX"],
  it: ["it"],
  pt: ["pt-PT"],
  br: ["pt-BR"],
  tr: ["tr"],
  ru: ["ru"],
  ua: ["uk"],
  pl: ["pl"],
  se: ["sv"],
  no: ["no"],
  dk: ["da"],
  fi: ["fi"],
  cz: ["cs"],
  gr: ["el"],
  hu: ["hu"],
  ro: ["ro"],
  jp: ["ja"],
  kr: ["ko"],
  cn: ["zh-Hans"],
  tw: ["zh-Hant"],
  hk: ["zh-Hant"],
  th: ["th"],
  vn: ["vi"],
  id: ["id"],
  my: ["ms"],
  sa: ["ar-SA"],
  ae: ["ar-SA", "en-GB"],
  il: ["he"],
};

/** Listing locales that count for a storefront, limited to locales the spec has. */
export function indexedLocales(project: Project, country: string): string[] {
  const cc = country.toLowerCase();
  const available = Object.keys(project.listings["app-store"]);
  const wanted = project.spec.storefronts[cc] ?? DEFAULT_STOREFRONT_LOCALES[cc] ?? [];
  const present = wanted.filter((l) => available.includes(l));
  if (present.length > 0) return present;
  const primary = project.spec.app.primaryLocale;
  return available.includes(primary) ? [primary] : available.slice(0, 1);
}

/** Best Google Play language for a storefront: exact match first, then the bare language, then the primary locale. */
export function playLanguageFor(project: Project, country: string): string | undefined {
  const available = Object.keys(project.listings["google-play"]);
  const appStoreGuess = (project.spec.storefronts[country] ?? DEFAULT_STOREFRONT_LOCALES[country] ?? [])[0];
  const candidates = [appStoreGuess, appStoreGuess?.split("-")[0], project.spec.app.primaryLocale].filter(Boolean) as string[];
  for (const c of candidates) {
    const hit = available.find((l) => l.toLowerCase() === c.toLowerCase()) ?? available.find((l) => l.toLowerCase().startsWith(`${c.toLowerCase()}-`));
    if (hit) return hit;
  }
  return available[0];
}

/** App Store locale code → Google Play language code, where they differ. */
const PLAY_LANGUAGE: Record<string, string> = {
  tr: "tr-TR", ja: "ja-JP", ko: "ko-KR", it: "it-IT", ru: "ru-RU", uk: "uk", "zh-Hans": "zh-CN", "zh-Hant": "zh-TW",
  "es-MX": "es-419", "ar-SA": "ar", he: "iw-IL", no: "no-NO", sv: "sv-SE", da: "da-DK", fi: "fi-FI", pl: "pl-PL",
  cs: "cs-CZ", el: "el-GR", hu: "hu-HU", ro: "ro", th: "th", vi: "vi", id: "id", ms: "ms", hi: "hi-IN", ca: "ca",
  hr: "hr", sk: "sk", "en-AU": "en-AU", "en-CA": "en-CA", "en-GB": "en-GB", "en-US": "en-US",
};

/** The Google Play language for an App Store locale (`tr` → `tr-TR`, `zh-Hans` → `zh-CN`). */
export function playLanguageCode(appStoreLocale: string): string {
  return PLAY_LANGUAGE[appStoreLocale] ?? appStoreLocale;
}
