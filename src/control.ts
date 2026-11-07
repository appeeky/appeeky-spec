import type { ReleaseRecord } from "./history.js";
import type { Project } from "./schema.js";
import { indexedLocales, playLanguageFor } from "./storefronts.js";
import type { RankSnapshot } from "./verify.js";

/**
 * A control group for a release: the storefronts whose listing did not change.
 *
 * A push to en-US changes what the US store reads; the German store reads de-DE and did not
 * change. Ranks there still move with everything else: the store's algorithm, the season,
 * competitors. Comparing the changed storefronts with the unchanged ones over the same days
 * takes that common move out, so a store-wide lift does not count as the release's win.
 */

/** Not ranked counts as just past the 200 results the stores return. */
const UNRANKED = 201;
const asRank = (r: number | null | undefined) => (r === null || r === undefined ? UNRANKED : r);

export interface ControlComparison {
  /** Storefronts whose indexed listing changed in this release. */
  changed: string[];
  /** Storefronts with targets whose listing did not change. */
  control: string[];
  /** Average places gained per target (positive is better), in each group. */
  changedMove: number;
  controlMove: number;
  /** changedMove − controlMove: what the release did beyond the store-wide move. */
  net: number;
}

/** Storefronts in the baseline whose listing this release changed. */
export function changedStorefronts(project: Project, release: ReleaseRecord, storefronts: string[]): string[] {
  const locales = new Set(release.changes.map((c) => c.locale));
  return storefronts.filter((cc) => {
    if (release.store === "app-store") return indexedLocales(project, cc).some((l) => locales.has(l));
    const lang = playLanguageFor(project, cc);
    return lang !== undefined && locales.has(lang);
  });
}

function averageMove(before: RankSnapshot, after: RankSnapshot, storefronts: string[]): { move: number; targets: number } {
  let sum = 0;
  let n = 0;
  for (const cc of storefronts)
    for (const [keyword, b] of Object.entries(before[cc] ?? {})) {
      if (!(keyword in (after[cc] ?? {}))) continue;
      // Cap each move so one keyword going from unranked to #5 does not drown the rest.
      sum += Math.max(-50, Math.min(50, asRank(b) - asRank(after[cc]![keyword])));
      n++;
    }
  return { move: n ? sum / n : 0, targets: n };
}

/** The fewest targets on each side for the comparison to mean anything. */
export const MIN_CONTROL_TARGETS = 3;

export function compareWithControl(project: Project, release: ReleaseRecord, before: RankSnapshot, after: RankSnapshot): ControlComparison | null {
  const storefronts = Object.keys(before);
  const changed = changedStorefronts(project, release, storefronts);
  const control = storefronts.filter((cc) => !changed.includes(cc));
  if (changed.length === 0 || control.length === 0) return null;
  const a = averageMove(before, after, changed);
  const b = averageMove(before, after, control);
  if (a.targets < MIN_CONTROL_TARGETS || b.targets < MIN_CONTROL_TARGETS) return null;
  const round = (x: number) => Math.round(x * 10) / 10;
  return { changed, control, changedMove: round(a.move), controlMove: round(b.move), net: round(a.move - b.move) };
}

/** A gain smaller than this, beyond the control group's, is the store moving, not the release. */
export const MIN_NET_PLACES = 2;
