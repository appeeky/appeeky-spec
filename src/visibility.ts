import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { AppeekyApi } from "./appeeky-api.js";
import { SPEC_DIR } from "./files.js";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { Project, SpecFile, StoreId } from "./schema.js";
import { indexedLocales } from "./storefronts.js";
import { normalize } from "./text.js";
import { rankAppIds } from "./verify.js";

/**
 * AI visibility in the repo: whether ChatGPT, Claude, Gemini and Perplexity name
 * the app when people ask for an app like it, who they name instead, and which
 * pages they cite. The intents and prompts live in appeeky.spec.yaml; Appeeky AI
 * Visibility asks the assistants on a schedule, and `visibility pull` writes what
 * they answered to appeeky/visibility/<country>.yaml.
 */

export const MODELS = ["chatgpt", "claude", "gemini", "perplexity"] as const;
export type Model = (typeof MODELS)[number];

export type AiIntent = NonNullable<SpecFile["aiVisibility"]>["intents"][string][number];

export const visibilityDir = (root: string) => join(root, SPEC_DIR, "visibility");
export const visibilityChangesFile = (root: string) => join(visibilityDir(root), "changes.md");

export interface VisibilityTarget {
  store: StoreId;
  /** The store id: numeric App Store id or Google Play package name. */
  appId: string;
  countries: string[];
}

/** Which app and storefronts to watch. */
export function visibilityTarget(project: Project): VisibilityTarget | null {
  const cfg = project.spec.aiVisibility;
  const ids = rankAppIds(project);
  const store = cfg?.store ?? (ids["app-store"] ? "app-store" : ids["google-play"] ? "google-play" : undefined);
  if (!store || !ids[store]) return null;
  const countries = cfg?.countries ?? [Object.keys(project.spec.targets)[0] ?? "us"];
  return { store, appId: ids[store]!, countries };
}

/** ISO 639-1 language for a storefront's prompts, from the listing locale it indexes first. */
export function languageFor(project: Project, country: string): string {
  return (indexedLocales(project, country)[0] ?? project.spec.app.primaryLocale).slice(0, 2).toLowerCase();
}

// ── API shapes (the parts read here) ────────────────────────────────────────

export interface RemoteIntentRow {
  intentId: string;
  label: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  visibilityPct: number;
  promptsTotal: number;
}

export interface RemotePrompt {
  promptId: string;
  text: string;
  status: "active" | "paused" | "archived";
}

interface Opportunity {
  intentId: string;
  label: string;
  status: "missing" | "weak" | "winning" | "no_data";
  ownerVisibilityPct: number | null;
  byModel: Partial<Record<Model, { visibilityPct: number; positionAvg: number | null; promptsTotal: number; date: string }>>;
  winners: Array<{ name: string; sharePct: number; models: Model[] }>;
}

interface OpportunitiesResponse {
  summary: { missing: number; weak: number; winning: number; noData: number };
  intents: Opportunity[];
  sources: {
    ownerDomain: string | null;
    sources: Array<{ domain: string; url: string; title: string | null; count: number; models: Model[]; citesOwner: boolean }>;
  };
}

interface FixResponse {
  id: string;
  intentId: string;
  kind: string;
  title: string;
  rationale: string;
  targetUrl: string | null;
  status: string;
}

interface TrendPoint {
  date: string;
  visibilityPct: number;
}

const path = (appId: string, rest = "") => `/ai-visibility/${encodeURIComponent(appId)}${rest}`;

export async function remoteIntents(api: AppeekyApi, appId: string, country: string): Promise<RemoteIntentRow[]> {
  const rows = await api.get<RemoteIntentRow[]>(path(appId, "/intents"), { country });
  return (rows ?? []).filter((r) => r.status !== "archived");
}

export async function remotePrompts(api: AppeekyApi, appId: string, country: string, intentId: string): Promise<RemotePrompt[]> {
  const detail = await api.get<{ prompts?: RemotePrompt[] }>(path(appId, `/intents/${encodeURIComponent(intentId)}`), { country });
  return (detail?.prompts ?? []).filter((p) => p.status !== "archived");
}

// ── The snapshot file ───────────────────────────────────────────────────────

export interface VisibilityFile {
  pulledAt: string;
  /** Where the answers came from: Appeeky AI Visibility, or `visibility scan --local` on your own keys. */
  source?: "appeeky" | "local";
  country: string;
  store: StoreId;
  appId: string;
  /** Intents by status: missing = no assistant names the app, weak = some do, rarely. */
  summary: { winning: number; weak: number; missing: number; noData: number };
  intents: Array<{
    label: string;
    status: Opportunity["status"];
    /** Share of prompts whose answer names the app, averaged over the assistants (0–100). */
    you?: number;
    byModel?: Partial<Record<Model, number>>;
    /** Who the assistants name instead. */
    namedInstead?: string[];
  }>;
  /** Pages the assistants cite, most cited first. */
  sources: Array<{ domain: string; count: number; yours?: true; url: string }>;
  /** What Appeeky suggests changing, still open. */
  fixes: Array<{ intent: string; title: string; why: string; page?: string }>;
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? undefined : Math.round(n));

export async function fetchVisibility(api: AppeekyApi, target: VisibilityTarget, country: string, now = new Date()): Promise<VisibilityFile> {
  const opp = await api.get<OpportunitiesResponse>(path(target.appId, "/opportunities"), { country, days: "30" });
  const fixes = await api.get<{ fixes?: FixResponse[] }>(path(target.appId, "/fixes"), { country }).catch(() => null);
  const labels = new Map((opp?.intents ?? []).map((i) => [i.intentId, i.label]));
  return {
    pulledAt: now.toISOString().slice(0, 10),
    country,
    store: target.store,
    appId: target.appId,
    summary: opp?.summary ?? { winning: 0, weak: 0, missing: 0, noData: 0 },
    intents: (opp?.intents ?? []).map((i) => {
      const byModel = Object.fromEntries(Object.entries(i.byModel).map(([m, s]) => [m, pct(s?.visibilityPct)!])) as Partial<Record<Model, number>>;
      return strip({
        label: i.label,
        status: i.status,
        you: pct(i.ownerVisibilityPct),
        byModel: Object.keys(byModel).length ? byModel : undefined,
        namedInstead: i.winners.length ? i.winners.slice(0, 5).map((w) => `${w.name} (${Math.round(w.sharePct)}%)`) : undefined,
      });
    }),
    sources: (opp?.sources.sources ?? []).slice(0, 15).map((s) => strip({ domain: s.domain, count: s.count, yours: s.citesOwner ? (true as const) : undefined, url: s.url })),
    fixes: (fixes?.fixes ?? [])
      .filter((f) => f.status === "open")
      .map((f) => strip({ intent: labels.get(f.intentId) ?? f.intentId, title: f.title, why: f.rationale, page: f.targetUrl ?? undefined })),
  };
}

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const visibilityPath = (root: string, country: string) => join(visibilityDir(root), `${country}.yaml`);

export async function readVisibility(root: string, country: string): Promise<VisibilityFile | null> {
  const file = visibilityPath(root, country);
  return existsSync(file) ? (YAML.parse(await readFile(file, "utf8")) as VisibilityFile) : null;
}

/** What moved since the last pull: an intent the assistants started or stopped naming the app for. */
export function visibilityChanges(prev: VisibilityFile, next: VisibilityFile): string[] {
  const out: string[] = [];
  const before = new Map(prev.intents.map((i) => [normalize(i.label), i]));
  const rank = { missing: 0, weak: 1, winning: 2, no_data: -1 } as const;
  for (const i of next.intents) {
    const was = before.get(normalize(i.label));
    if (!was || was.status === "no_data" || i.status === "no_data" || was.status === i.status) continue;
    const verb = rank[i.status] > rank[was.status] ? "up" : "down";
    out.push(`"${i.label}": ${was.status} → ${i.status} (${was.you ?? 0}% → ${i.you ?? 0}%), ${verb}`);
  }
  const cited = (f: VisibilityFile) => f.sources.some((s) => s.yours);
  if (!cited(prev) && cited(next)) out.push("the assistants now cite your own site");
  if (cited(prev) && !cited(next)) out.push("the assistants stopped citing your own site");
  return out;
}

export async function recordChanges(root: string, date: string, country: string, changes: string[]): Promise<void> {
  if (changes.length === 0) return;
  const file = visibilityChangesFile(root);
  const old = existsSync(file) ? await readFile(file, "utf8") : "# AI visibility changes\n\nWritten by `visibility pull`: intents the assistants started or stopped naming the app for.\n";
  const [head, ...rest] = old.split(/\n(?=- )/);
  const lines = changes.map((c) => `- ${date} · ${country.toUpperCase()} · ${c}`);
  await writeFile(file, [head!.trimEnd(), "", ...lines, ...rest.map((r) => r.trimEnd())].join("\n") + "\n");
}

/** Pull every watched storefront and write its file. */
export async function pullVisibility(api: AppeekyApi, project: Project, countries?: string[], now = new Date()): Promise<Array<{ country: string; file?: string; data?: VisibilityFile; changes: string[]; error?: string }>> {
  const target = visibilityTarget(project);
  if (!target) throw new Error("Set stores.appStore.appId (numeric) or stores.googlePlay.packageName first.");
  await mkdir(visibilityDir(project.root), { recursive: true });
  const out: Array<{ country: string; file?: string; data?: VisibilityFile; changes: string[]; error?: string }> = [];
  for (const country of countries ?? target.countries) {
    try {
      const data = await fetchVisibility(api, target, country, now);
      const file = visibilityPath(project.root, country);
      const prev = await readVisibility(project.root, country);
      const changes = prev ? visibilityChanges(prev, data) : [];
      await recordChanges(project.root, data.pulledAt, country, changes);
      await writeFile(file, YAML.stringify(data, { lineWidth: 0 }));
      out.push({ country, file, data, changes });
    } catch (e) {
      out.push({ country, changes: [], error: (e as Error).message });
    }
  }
  return out;
}

// ── Intents as code ─────────────────────────────────────────────────────────

/** The intents and prompts Appeeky tracks for a storefront, in the spec's shape. */
export async function readRemoteIntents(api: AppeekyApi, appId: string, country: string): Promise<AiIntent[]> {
  const out: AiIntent[] = [];
  for (const i of await remoteIntents(api, appId, country)) {
    const prompts = await remotePrompts(api, appId, country, i.intentId);
    out.push(strip({ label: i.label, description: i.description ?? undefined, prompts: prompts.map((p) => p.text) }));
  }
  return out;
}

/** Ask Appeeky to write intents and prompts from the store listing (runs in the background). */
export async function bootstrapIntents(api: AppeekyApi, appId: string, country: string, language: string): Promise<{ queued: boolean; already: boolean }> {
  const r = await api.post<{ alreadyBootstrapped?: boolean; alreadyQueued?: boolean; taskRunId?: string }>(`${path(appId, "/bootstrap")}?country=${encodeURIComponent(country)}&language=${encodeURIComponent(language)}`, {});
  return { queued: Boolean(r?.taskRunId), already: Boolean(r?.alreadyBootstrapped) };
}

export interface SyncPlan {
  country: string;
  addIntents: AiIntent[];
  addPrompts: Array<{ intentId: string; label: string; text: string }>;
  /** Tracked in Appeeky but not in the spec: archived only with --prune. */
  extraIntents: Array<{ intentId: string; label: string }>;
  extraPrompts: Array<{ promptId: string; label: string; text: string }>;
}

const key = (s: string) => normalize(s).replace(/\s+/g, " ").trim();

/** Compare the spec's intents for a storefront with what Appeeky tracks. */
export async function planSync(api: AppeekyApi, appId: string, country: string, wanted: AiIntent[]): Promise<SyncPlan> {
  const remote = await remoteIntents(api, appId, country);
  const byLabel = new Map(remote.map((r) => [key(r.label), r]));
  const plan: SyncPlan = { country, addIntents: [], addPrompts: [], extraIntents: [], extraPrompts: [] };
  const seen = new Set<string>();
  for (const intent of wanted) {
    const r = byLabel.get(key(intent.label));
    if (!r) {
      plan.addIntents.push(intent);
      continue;
    }
    seen.add(r.intentId);
    const prompts = await remotePrompts(api, appId, country, r.intentId);
    const have = new Map(prompts.map((p) => [key(p.text), p]));
    const want = new Set(intent.prompts.map(key));
    for (const text of intent.prompts) if (!have.has(key(text))) plan.addPrompts.push({ intentId: r.intentId, label: intent.label, text });
    for (const p of prompts) if (!want.has(key(p.text))) plan.extraPrompts.push({ promptId: p.promptId, label: intent.label, text: p.text });
  }
  for (const r of remote) if (!seen.has(r.intentId)) plan.extraIntents.push({ intentId: r.intentId, label: r.label });
  return plan;
}

/** Apply a plan: add what the spec has; archive what it does not only when `prune` is set. */
export async function applySync(api: AppeekyApi, appId: string, plan: SyncPlan, language: string, prune: boolean): Promise<{ intents: number; prompts: number; archived: number }> {
  const q = `?country=${encodeURIComponent(plan.country)}&language=${encodeURIComponent(language)}`;
  let intents = 0;
  let prompts = 0;
  let archived = 0;
  for (const intent of plan.addIntents) {
    const created = await api.post<{ id: string }>(`${path(appId, "/intents")}${q}`, { label: intent.label, description: intent.description ?? null });
    intents++;
    for (const text of intent.prompts) {
      await api.post(`${path(appId, `/intents/${encodeURIComponent(created.id)}/prompts`)}${q}`, { text });
      prompts++;
    }
  }
  for (const p of plan.addPrompts) {
    await api.post(`${path(appId, `/intents/${encodeURIComponent(p.intentId)}/prompts`)}${q}`, { text: p.text });
    prompts++;
  }
  if (prune) {
    for (const p of plan.extraPrompts) {
      await api.request("DELETE", path(appId, `/prompts/${encodeURIComponent(p.promptId)}`));
      archived++;
    }
    for (const i of plan.extraIntents) {
      await api.request("DELETE", `${path(appId, `/intents/${encodeURIComponent(i.intentId)}`)}`);
      archived++;
    }
  }
  return { intents, prompts, archived };
}

/** Ask the assistants now instead of waiting for the schedule. Charged in AI Visibility credits. */
export async function scanVisibility(api: AppeekyApi, appId: string, country: string): Promise<unknown> {
  return api.post(`${path(appId, "/scan")}?country=${encodeURIComponent(country)}`, {});
}

// ── Measuring ───────────────────────────────────────────────────────────────

/**
 * `ai_visibility` around a push: the share of prompts whose answer names the
 * app, averaged over the scanned days in the window and the assistants (0–1).
 * Reads Appeeky's daily series once per assistant per run.
 */
export function visibilityMetricSource(api: AppeekyApi, project: Project): MetricSource | null {
  const target = visibilityTarget(project);
  if (!target) return null;
  const country = target.countries[0]!;
  let series: Promise<TrendPoint[][]> | undefined;
  return {
    label: "Appeeky AI Visibility",
    async window(store, _appId, from, to) {
      if (store !== target.store) return null;
      series ??= Promise.all(MODELS.map((model) => api.get<TrendPoint[]>(path(target.appId, "/trend"), { country, model, windowDays: "90" }).then((s) => s ?? []).catch(() => [])));
      const byDay = new Map<string, number[]>();
      for (const points of await series) {
        for (const p of points) {
          if (p.date < from || p.date >= to) continue;
          byDay.set(p.date, [...(byDay.get(p.date) ?? []), p.visibilityPct]);
        }
      }
      if (byDay.size === 0) return null;
      const daily = [...byDay.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
      const values: MetricWindow["values"] = { ai_visibility: daily.reduce((a, b) => a + b, 0) / daily.length / 100 };
      return { from, to, days, values };
    },
  };
}
