/** Text helpers shared by the lint rules and the coverage report. */

const encoder = new TextEncoder();

/** UTF-8 byte length: the unit Apple uses for the 100-byte keyword field. */
export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Character count as the stores count it (user-perceived characters, not UTF-16 units). */
export function charLength(value: string): number {
  return [...value].length;
}

export function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

/** Lowercased words; punctuation and symbols split words, apostrophes inside a word are kept. */
export function words(value: string | undefined): string[] {
  if (!value) return [];
  return (
    normalize(value)
      .replace(/[’']/g, "'")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []
  );
}

/** Entries of an App Store keyword field, as written (trimmed, empty ones dropped). */
export function keywordEntries(field: string | undefined): string[] {
  if (!field) return [];
  return field
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Naive English singular form, only used to flag likely plural pairs. */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es") && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function isEnglish(locale: string): boolean {
  return locale.toLowerCase().startsWith("en");
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** Short English words that do not decide a search; ignored when a phrase has other words. */
export const STOPWORDS = new Set(["a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "with", "my", "your", "by", "at", "app", "apps"]);

/** Words of a target that matter for coverage: stopwords drop out unless they are all there is. */
export function keyWords(value: string): string[] {
  const all = words(value);
  const kept = all.filter((w) => !STOPWORDS.has(w));
  return kept.length > 0 ? kept : all;
}
