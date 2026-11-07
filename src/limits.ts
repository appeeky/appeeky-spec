import type { StoreId } from "./schema.js";

export interface FieldLimit {
  max: number;
  /** Characters as App Store Connect counts them (a Cyrillic or CJK letter is one). */
  unit: "chars";
}

export const LIMITS: Record<StoreId, Record<string, FieldLimit>> = {
  "app-store": {
    name: { max: 30, unit: "chars" },
    subtitle: { max: 30, unit: "chars" },
    keywords: { max: 100, unit: "chars" },
    promotionalText: { max: 170, unit: "chars" },
    description: { max: 4000, unit: "chars" },
    whatsNew: { max: 4000, unit: "chars" },
  },
  "google-play": {
    title: { max: 30, unit: "chars" },
    shortDescription: { max: 80, unit: "chars" },
    fullDescription: { max: 4000, unit: "chars" },
  },
};

/**
 * Fields that go live without a new app version. On the App Store only the
 * promotional text changes on the live version; everything else waits for the
 * next version you submit.
 */
export const LIVE_EDITABLE: Record<StoreId, ReadonlySet<string>> = {
  "app-store": new Set(["promotionalText"]),
  "google-play": new Set(["title", "shortDescription", "fullDescription", "video"]),
};

/** Fields the store indexes for search. */
export const INDEXED_FIELDS: Record<StoreId, readonly string[]> = {
  "app-store": ["name", "subtitle", "keywords"],
  "google-play": ["title", "shortDescription", "fullDescription"],
};
