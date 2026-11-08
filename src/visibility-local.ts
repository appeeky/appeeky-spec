import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { Project } from "./schema.js";
import { indexedLocales, playLanguageFor } from "./storefronts.js";
import { languageFor, readVisibility, recordChanges, visibilityChanges, visibilityDir, visibilityPath, visibilityTarget, type AiIntent, type Model, type VisibilityFile } from "./visibility.js";

/**
 * AI visibility on your own model keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
 * PERPLEXITY_API_KEY: any of them). The prompts in appeeky.spec.yaml go to each assistant with web
 * search on, a cheap second call lists the apps each answer names, and the result is written to the
 * same appeeky/visibility/<country>.yaml that `visibility pull` writes. The providers bill you
 * directly; no Appeeky account is needed. The pipeline ships inside Spec as dist/visibility-core.js.
 */

type Env = Record<string, string | undefined>;

interface Citation {
  url: string;
  title?: string;
}
interface Answer {
  model: Model;
  modelId: string;
  status: "ok" | "refusal" | "error";
  text: string;
  citations: Citation[];
  costUsd: number;
  error?: string;
}
interface Mention {
  name: string;
  position: number | null;
  citation: number | null;
}
interface Helper {
  model: Model;
  modelId: string;
  key: string;
  estimateUsd: number;
}
interface ScoredAnswer {
  intent: string;
  prompt: string;
  model: Model;
  status: Answer["status"];
  mentions: Mention[];
  citations: Citation[];
}
interface IntentScore {
  label: string;
  status: "missing" | "weak" | "winning" | "no_data";
  you?: number;
  byModel: Partial<Record<Model, { pct: number; position: number | null; prompts: number }>>;
  namedInstead: Array<{ name: string; pct: number; models: Model[] }>;
}
export interface AppContext {
  title: string;
  subtitle?: string;
  description?: string;
  keywords?: string[];
  competitors?: string[];
  country: string;
  language: string;
}

export interface VisibilityCore {
  MODELS: Model[];
  PROVIDERS: Record<Model, { env: string[]; modelId: string; estimateUsd: number }>;
  keyFor(model: Model, env: Env): string | undefined;
  availableModels(env: Env, wanted?: Model[]): Model[];
  helperFor(env: Env): Helper | null;
  quoteScan(prompts: number, models: Model[], env: Env): number;
  ask(model: Model, key: string, input: { prompt: string; country: string; language: string }, fetcher?: typeof fetch): Promise<Answer>;
  extract(helper: Helper, input: { answer: string; prompt: string; owner: string; competitors: string[]; citations: Citation[] }, fetcher?: typeof fetch): Promise<{ refusal: boolean; mentions: Mention[]; costUsd: number }>;
  isOwner(name: string, titles: string[]): boolean;
  score(answers: ScoredAnswer[], intents: string[], owner: string[]): IntentScore[];
  citedDomains(answers: ScoredAnswer[], ownDomains: string[]): Array<{ domain: string; count: number; url: string; yours?: true }>;
  generateIntents(
    helper: Helper,
    app: AppContext,
    opts?: { maxIntents?: number; promptsPerIntent?: number; exclude?: string[] },
    fetcher?: typeof fetch,
  ): Promise<{ intents: Array<{ label: string; description?: string; prompts: string[] }>; costUsd: number }>;
}

export const VISIBILITY_CORE_FILE = "./visibility-core.js";

export async function loadVisibilityCore(load: (specifier: string) => Promise<Record<string, unknown>> = (s) => import(s)): Promise<VisibilityCore> {
  try {
    return (await load(VISIBILITY_CORE_FILE)) as unknown as VisibilityCore;
  } catch {
    throw new Error("This build of @appeeky/spec has no AI visibility pipeline (dist/visibility-core.js). Update it: npm install -g @appeeky/spec@latest");
  }
}

export const KEY_NAMES = "OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY or PERPLEXITY_API_KEY";

/** The listing the storefront shows, as context for intents and prompts. */
export function appContext(project: Project, country: string): AppContext {
  const as = project.listings["app-store"][indexedLocales(project, country)[0] ?? ""];
  const playLang = playLanguageFor(project, country);
  const gp = playLang ? project.listings["google-play"][playLang] : undefined;
  return {
    title: as?.name ?? gp?.title ?? project.spec.app.name,
    subtitle: as?.subtitle ?? gp?.shortDescription,
    description: as?.description ?? gp?.fullDescription,
    keywords: project.spec.targets[country] ?? [],
    competitors: project.spec.competitors.map((c) => c.name).filter((n): n is string => Boolean(n)),
    country,
    language: languageFor(project, country),
  };
}

/** Every name the assistants may use for the app. */
export function ownerNames(project: Project): string[] {
  const names = new Set<string>([project.spec.app.name, ...(project.spec.aiVisibility?.aliases ?? [])]);
  for (const l of Object.values(project.listings["app-store"])) if (l.name) names.add(l.name);
  for (const l of Object.values(project.listings["google-play"])) if (l.title) names.add(l.title);
  return [...names];
}

/** The app's own domains: its website and the listing's marketing and support URLs. */
export function ownDomains(project: Project): string[] {
  const urls = [project.spec.web?.url, ...Object.values(project.listings["app-store"]).flatMap((l) => [l.marketingUrl, l.supportUrl])];
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      if (!/(^|\.)(apple\.com|google\.com|notion\.site|github\.io)$/.test(host)) out.add(host);
    } catch {
      // not a URL
    }
  }
  return [...out];
}

export interface LocalScanPlan {
  country: string;
  intents: AiIntent[];
  prompts: number;
  models: Model[];
  helper: Helper | null;
  quoteUsd: number;
}

export function planLocalScan(core: VisibilityCore, project: Project, country: string, env: Env): LocalScanPlan {
  const intents = project.spec.aiVisibility?.intents[country] ?? [];
  const models = core.availableModels(env, project.spec.aiVisibility?.models as Model[] | undefined);
  const prompts = intents.reduce((n, i) => n + i.prompts.length, 0);
  return { country, intents, prompts, models, helper: core.helperFor(env), quoteUsd: core.quoteScan(prompts, models, env) };
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}

export const historyFile = (root: string) => join(visibilityDir(root), "history.csv");
export const answersFile = (root: string, country: string) => join(visibilityDir(root), "answers", `${country}.jsonl`);
const HISTORY_HEADER = "date,country,intent,model,visibility_pct,position,prompts\n";
const csv = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export interface LocalScanResult {
  country: string;
  file: string;
  data: VisibilityFile;
  changes: string[];
  costUsd: number;
  answered: number;
  failed: Array<{ model: Model; error: string }>;
}

/** Ask every assistant every prompt for one storefront, then write the snapshot, the answers and a history row per intent and assistant. */
export async function scanLocal(
  core: VisibilityCore,
  project: Project,
  plan: LocalScanPlan,
  env: Env,
  options: { fetcher?: typeof fetch; now?: Date; concurrency?: number; log?: (line: string) => void } = {},
): Promise<LocalScanResult> {
  const { country } = plan;
  if (!plan.helper) throw new Error(`Set ${KEY_NAMES} to scan with your own keys.`);
  if (plan.models.length === 0) throw new Error(`None of the assistants in aiVisibility.models has a key. Set ${KEY_NAMES}.`);
  const target = visibilityTarget(project);
  const now = options.now ?? new Date();
  const owner = ownerNames(project);
  const ctx = appContext(project, country);
  const jobs = plan.intents.flatMap((i) => i.prompts.map((prompt) => plan.models.map((model) => ({ intent: i.label, prompt, model })))).flat();
  const scored: ScoredAnswer[] = [];
  const raw: Array<ScoredAnswer & { text: string; error?: string }> = [];
  const failed: LocalScanResult["failed"] = [];
  let cost = 0;
  let done = 0;
  await pool(jobs, options.concurrency ?? 4, async (job) => {
    const answer = await core.ask(job.model, core.keyFor(job.model, env)!, { prompt: job.prompt, country, language: ctx.language }, options.fetcher);
    cost += answer.costUsd;
    let mentions: Mention[] = [];
    let status = answer.status;
    if (answer.status === "ok") {
      try {
        const x = await core.extract(plan.helper!, { answer: answer.text, prompt: job.prompt, owner: owner[0]!, competitors: ctx.competitors ?? [], citations: answer.citations }, options.fetcher);
        cost += x.costUsd;
        mentions = x.mentions;
        if (x.refusal) status = "refusal";
      } catch (e) {
        status = "error";
        answer.error = `extracting the apps: ${(e as Error).message}`;
      }
    }
    if (status === "error") failed.push({ model: job.model, error: answer.error ?? "no answer" });
    const row: ScoredAnswer = { ...job, status, mentions, citations: answer.citations };
    scored.push(row);
    raw.push({ ...row, text: answer.text, ...(answer.error ? { error: answer.error } : {}) });
    done++;
    if (done % 10 === 0 || done === jobs.length) options.log?.(`${done}/${jobs.length} answers`);
  });

  const labels = plan.intents.map((i) => i.label);
  const scores = core.score(scored, labels, owner);
  const sources = core.citedDomains(scored, ownDomains(project));
  const summary = { winning: 0, weak: 0, missing: 0, noData: 0 };
  for (const s of scores) {
    if (s.status === "no_data") summary.noData++;
    else summary[s.status]++;
  }
  const order = { missing: 0, weak: 1, winning: 2, no_data: 3 } as const;
  const date = now.toISOString().slice(0, 10);
  const data: VisibilityFile = {
    pulledAt: date,
    source: "local",
    country,
    store: target?.store ?? "app-store",
    appId: target?.appId ?? project.spec.app.name,
    summary,
    intents: [...scores]
      .sort((a, b) => order[a.status] - order[b.status] || (a.you ?? 0) - (b.you ?? 0))
      .map((s) => {
        const byModel = Object.fromEntries(Object.entries(s.byModel).map(([m, v]) => [m, Math.round(v!.pct)])) as Partial<Record<Model, number>>;
        return {
          label: s.label,
          status: s.status,
          ...(s.you !== undefined ? { you: Math.round(s.you) } : {}),
          ...(Object.keys(byModel).length ? { byModel } : {}),
          ...(s.namedInstead.length ? { namedInstead: s.namedInstead.map((w) => `${w.name} (${Math.round(w.pct)}%)`) } : {}),
        };
      }),
    sources: sources.slice(0, 15).map((s) => ({ domain: s.domain, count: s.count, ...(s.yours ? { yours: true as const } : {}), url: s.url })),
    fixes: [],
  };

  await mkdir(join(visibilityDir(project.root), "answers"), { recursive: true });
  const file = visibilityPath(project.root, country);
  const prev = await readVisibility(project.root, country);
  const changes = prev ? visibilityChanges(prev, data) : [];
  await recordChanges(project.root, date, country, changes);
  await writeFile(file, YAML.stringify(data, { lineWidth: 0 }));
  const byPrompt = (a: { intent: string; prompt: string; model: string }) => `${a.intent}\u0000${a.prompt}\u0000${a.model}`;
  raw.sort((a, b) => byPrompt(a).localeCompare(byPrompt(b)));
  await writeFile(answersFile(project.root, country), raw.map((r) => JSON.stringify({ date, ...r })).join("\n") + "\n");
  const hist = historyFile(project.root);
  if (!existsSync(hist)) await writeFile(hist, HISTORY_HEADER);
  const rows = scores.flatMap((s) => Object.entries(s.byModel).map(([m, v]) => [date, country, s.label, m, v!.pct, v!.position, v!.prompts].map(csv).join(",")));
  if (rows.length) await appendFile(hist, rows.join("\n") + "\n");
  return { country, file, data, changes, costUsd: Math.round(cost * 100) / 100, answered: scored.filter((a) => a.status !== "error").length, failed };
}

/** Days since the last local scan of a storefront, from history.csv; null when it never ran. */
export async function daysSinceLocalScan(root: string, country: string, now = new Date()): Promise<number | null> {
  const rows = await readHistory(root);
  const last = rows.filter((r) => r.country === country).map((r) => r.date).sort().at(-1);
  return last ? Math.floor((now.getTime() - Date.parse(last)) / 86_400_000) : null;
}

interface HistoryRow {
  date: string;
  country: string;
  intent: string;
  model: string;
  pct: number;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function readHistory(root: string): Promise<HistoryRow[]> {
  const file = historyFile(root);
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [date, country, intent, model, pct] = splitCsv(l);
      return { date: date!, country: country!, intent: intent!, model: model!, pct: Number(pct) };
    });
}

/** `ai_visibility` from the local scans in the repo: the share of answers that name the app, averaged per scan day (0–1). */
export function localVisibilityMetricSource(project: Project): MetricSource | null {
  const target = visibilityTarget(project);
  if (!target || !existsSync(historyFile(project.root))) return null;
  const country = target.countries[0]!;
  let history: Promise<HistoryRow[]> | undefined;
  return {
    label: "AI visibility scans in the repo",
    async window(store, _appId, from, to) {
      if (store !== target.store) return null;
      history ??= readHistory(project.root);
      const byDay = new Map<string, number[]>();
      for (const r of await history) if (r.country === country && r.date >= from && r.date < to && Number.isFinite(r.pct)) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r.pct]);
      if (byDay.size === 0) return null;
      const daily = [...byDay.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
      const values: MetricWindow["values"] = { ai_visibility: daily.reduce((a, b) => a + b, 0) / daily.length / 100 };
      return { from, to, days, values };
    },
  };
}
