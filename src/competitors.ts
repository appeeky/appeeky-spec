import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { AppeekyApi } from "./appeeky-api.js";
import { SPEC_DIR } from "./files.js";
import type { SpecFile, StoreId } from "./schema.js";
import { normalize } from "./text.js";

/**
 * Competitors in the repo: their listing, the searches they rank for, and what
 * their users say, one file per competitor in appeeky/competitors/. Pull again
 * and the git diff shows what they changed.
 */

export type Competitor = SpecFile["competitors"][number];

export const competitorsDir = (root: string) => join(root, SPEC_DIR, "competitors");

export function competitorSlug(c: Competitor): string {
  const base = c.name ?? c.appStore ?? c.googlePlay ?? "competitor";
  return normalize(base).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "competitor";
}

interface AppResponse {
  title?: string;
  developer?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  metadata?: {
    trackName?: string;
    description?: string;
    version?: string;
    releaseNotes?: string;
    currentVersionReleaseDate?: string;
    averageUserRating?: number;
    userRatingCount?: number;
    primaryGenreName?: string;
  };
}

interface KeywordRow {
  keyword: string;
  rank: number | null;
  popularity?: number;
  volumeScore?: number;
  trend?: string;
}

interface PublicReview {
  rating: number;
  title?: string;
  content?: string;
  date?: string;
}

export interface CompetitorStore {
  id: string;
  title?: string;
  developer?: string;
  rating?: number;
  ratings?: number;
  version?: string;
  updated?: string;
  releaseNotes?: string;
  description?: string;
  /** The searches it ranks for in `country`, best first. */
  ranks: Array<{ keyword: string; rank: number; popularity?: number; trend?: string }>;
  /** Where it ranks for your own targets. */
  yourTargets: Array<{ keyword: string; rank: number }>;
  recentReviews?: { count: number; average: number; low: Array<{ rating: number; text: string }> };
}

export interface CompetitorFile {
  name: string;
  pulledAt: string;
  country: string;
  stores: Partial<Record<StoreId, CompetitorStore>>;
}

const platform = (store: StoreId) => (store === "app-store" ? "apple" : "google");
const trim = (s: string | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s) : undefined);
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;

export async function fetchCompetitorStore(api: AppeekyApi, store: StoreId, id: string, country: string, targets: string[]): Promise<CompetitorStore> {
  const q = { country, platform: platform(store) };
  const app = (await api.get<AppResponse>(`/apps/${encodeURIComponent(id)}`, q)) ?? {};
  const kw = await api.get<{ keywords?: KeywordRow[] }>(`/apps/${encodeURIComponent(id)}/keywords`, q).catch(() => null);
  const rv = await api.get<{ reviews?: PublicReview[] }>(`/apps/${encodeURIComponent(id)}/reviews`, { ...q, sortBy: "mostRecent", page: "1" }).catch(() => null);
  const ranked = (kw?.keywords ?? []).filter((k): k is KeywordRow & { rank: number } => typeof k.rank === "number").sort((a, b) => a.rank - b.rank);
  const wanted = new Set(targets.map((t) => normalize(t).trim()));
  const reviews = rv?.reviews ?? [];
  const m = app.metadata ?? {};
  return clean({
    id,
    title: app.title ?? m.trackName,
    developer: app.developer,
    rating: round(app.averageUserRating ?? m.averageUserRating),
    ratings: app.userRatingCount ?? m.userRatingCount,
    version: m.version,
    updated: m.currentVersionReleaseDate?.slice(0, 10),
    releaseNotes: trim(m.releaseNotes, 300),
    description: trim(m.description, 600),
    ranks: ranked.slice(0, 25).map((k) => clean({ keyword: k.keyword, rank: k.rank, popularity: k.popularity ?? k.volumeScore, trend: k.trend })),
    yourTargets: ranked.filter((k) => wanted.has(normalize(k.keyword).trim())).map((k) => ({ keyword: k.keyword, rank: k.rank })),
    recentReviews: reviews.length
      ? {
          count: reviews.length,
          average: round(reviews.reduce((n, r) => n + r.rating, 0) / reviews.length)!,
          low: reviews
            .filter((r) => r.rating <= 2)
            .slice(0, 5)
            .map((r) => ({ rating: r.rating, text: trim([r.title, r.content].filter(Boolean).join(". ").replace(/\s+/g, " "), 160)! })),
        }
      : undefined,
  });
}

function round(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n * 100) / 100;
}

/**
 * What a competitor changed since the last pull: its title, a new version, a rewritten
 * description, or a climb into the top 10 for one of your targets.
 */
export function competitorChanges(prev: CompetitorFile, next: CompetitorFile): string[] {
  const out: string[] = [];
  for (const store of ["app-store", "google-play"] as const) {
    const a = prev.stores[store];
    const b = next.stores[store];
    if (!a || !b) continue;
    const where = store === "app-store" ? "App Store" : "Google Play";
    if (a.title && b.title && a.title !== b.title) out.push(`${where}: title "${a.title}" → "${b.title}"`);
    if (a.version && b.version && a.version !== b.version) out.push(`${where}: version ${b.version}${b.releaseNotes ? `: ${trim(b.releaseNotes.replace(/\s+/g, " "), 90)}` : ""}`);
    if (a.description && b.description && a.description !== b.description) out.push(`${where}: rewrote the description`);
    const before = new Map(a.yourTargets.map((t) => [t.keyword, t.rank]));
    for (const t of b.yourTargets) {
      const was = before.get(t.keyword);
      if (t.rank <= 10 && (was === undefined || was > 10)) out.push(`${where}: now #${t.rank} for "${t.keyword}" (was ${was === undefined ? "not ranked" : `#${was}`})`);
    }
  }
  return out;
}

export const changesFile = (root: string) => join(competitorsDir(root), "changes.md");

/** Add the day's changes to appeeky/competitors/changes.md, newest first. */
async function recordChanges(root: string, date: string, name: string, changes: string[]): Promise<void> {
  if (changes.length === 0) return;
  const file = changesFile(root);
  const old = existsSync(file) ? await readFile(file, "utf8") : "# Competitor changes\n\nWritten by `competitors pull`: what each competitor changed since the pull before.\n";
  const [head, ...rest] = old.split(/\n(?=- )/);
  const lines = changes.map((c) => `- ${date} · ${name} · ${c}`);
  await writeFile(file, [head!.trimEnd(), "", ...lines, ...rest.map((r) => r.trimEnd())].join("\n") + "\n");
}

/** Competitor changes recorded on or after a date, from changes.md. */
export async function readChanges(root: string): Promise<Array<{ date: string; name: string; change: string }>> {
  const file = changesFile(root);
  if (!existsSync(file)) return [];
  const out: Array<{ date: string; name: string; change: string }> = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2}) · (.+?) · (.+)$/);
    if (m) out.push({ date: m[1]!, name: m[2]!, change: m[3]! });
  }
  return out;
}

/** Pull every competitor listed in the spec and write its file. */
export async function pullCompetitors(api: AppeekyApi, root: string, spec: SpecFile, now = new Date()): Promise<Array<{ file: string; errors: string[]; changes: string[] }>> {
  const country = Object.keys(spec.targets)[0] ?? "us";
  const targets = spec.targets[country] ?? [];
  const out: Array<{ file: string; errors: string[]; changes: string[] }> = [];
  await mkdir(competitorsDir(root), { recursive: true });
  for (const c of spec.competitors) {
    const data: CompetitorFile = { name: c.name ?? c.appStore ?? c.googlePlay ?? "competitor", pulledAt: now.toISOString().slice(0, 10), country, stores: {} };
    const errors: string[] = [];
    for (const [store, id] of [["app-store", c.appStore], ["google-play", c.googlePlay]] as const) {
      if (!id) continue;
      try {
        data.stores[store] = await fetchCompetitorStore(api, store, id, country, targets);
        if (!c.name && data.stores[store]?.title) data.name = data.stores[store]!.title!;
      } catch (e) {
        errors.push(`${store}: ${(e as Error).message}`);
      }
    }
    const file = join(competitorsDir(root), `${competitorSlug({ ...c, name: data.name })}.yaml`);
    let changes: string[] = [];
    if (Object.keys(data.stores).length) {
      const prev = await readCompetitor(file);
      changes = prev ? competitorChanges(prev, data) : [];
      await recordChanges(root, data.pulledAt, data.name, changes);
      await writeFile(file, YAML.stringify(data, { lineWidth: 0 }));
    }
    out.push({ file, errors, changes });
  }
  return out;
}

/** Apps like yours, to pick competitors from. */
export async function similarApps(api: AppeekyApi, store: StoreId, id: string, country: string): Promise<Array<{ id: string; title: string; rating?: number; ratings?: number }>> {
  const data = await api.get<Array<{ appId: string; title: string; rating?: number; reviewsCount?: number }>>(`/apps/${encodeURIComponent(id)}/similar`, { country, platform: platform(store) });
  return (data ?? []).map((a) => clean({ id: String(a.appId), title: a.title, rating: a.rating, ratings: a.reviewsCount }));
}

export async function readCompetitor(file: string): Promise<CompetitorFile | null> {
  return existsSync(file) ? (YAML.parse(await readFile(file, "utf8")) as CompetitorFile) : null;
}
