import { fieldsFor, type Listing, type StoreId, type StoreListings } from "./schema.js";
import type { FieldChange } from "./stores/types.js";

/** Stores trim trailing whitespace and normalize line endings, so compare the same way. */
export function normalizeValue(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

/**
 * Field-level differences for the fields the spec manages. A locale or field
 * that is only in the store is left alone: the spec owns what it lists.
 */
export function diffListings<L extends Listing>(
  store: StoreId,
  local: StoreListings<L>,
  remote: StoreListings<L>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [locale, listing] of Object.entries(local)) {
    const live = remote[locale] as Record<string, string | undefined> | undefined;
    for (const field of fieldsFor(store)) {
      const after = normalizeValue((listing as Record<string, string | undefined>)[field]);
      if (after === undefined) continue;
      const before = normalizeValue(live?.[field]);
      // "" in the spec clears the field; empty and missing are the same.
      if ((before ?? "") === after) continue;
      changes.push({ store, locale, field, before, after, newLocale: live === undefined });
    }
  }
  return changes;
}

/** The inverse of a set of applied changes: what to push to go back. A field that was empty goes back to "" (cleared). */
export function invertChanges(changes: FieldChange[]): FieldChange[] {
  return changes.map((c) => ({ ...c, before: c.after, after: c.before ?? "", newLocale: false, blocked: undefined }));
}
