import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { Project } from "./schema.js";
import { seoDir } from "./seo.js";
import { rankAppIds } from "./verify.js";

/**
 * Google search for the app's website on your own DataForSEO account (DATAFORSEO_LOGIN,
 * DATAFORSEO_PASSWORD), no Appeeky account:
 *
 *   seo ranks     where the site, and the app's store page, rank on Google for each keyword,
 *                 and whether Google's AI Overview cites the site (appeeky/seo/ranks.csv, ranks.md)
 *   seo keywords  search volume, difficulty, CPC and intent for the keywords, plus related ideas
 *   seo domain    what the site ranks for, its estimated traffic, and the domains it competes with
 *
 * The keywords are web.keywords.<country>, or the store targets of that storefront.
 * DataForSEO bills each call; every command can quote first with --dry-run.
 */

export interface DfsAuth {
  login: string;
  password: string;
}

export function readDataForSeo(env: Record<string, string | undefined>): DfsAuth | null {
  const login = env.DATAFORSEO_LOGIN?.trim();
  const password = env.DATAFORSEO_PASSWORD?.trim();
  if (!login && !password) return null;
  if (!login || !password) throw new Error("DataForSEO needs both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (from app.dataforseo.com → API access).");
  return { login, password };
}

/** Rough prices for the quote, in USD; the real cost of every call is added up from the responses. */
export const DFS_PRICE = { serp: 0.02, keywordOverview: 0.0101, related: 0.0135, domain: 0.0505 } as const;

const ISO_NUMERIC: Record<string, number> = {
  ar: 32, at: 40, au: 36, be: 56, bg: 100, br: 76, ca: 124, ch: 756, cl: 152, cn: 156, co: 170, cz: 203, de: 276, dk: 208, ee: 233,
  eg: 818, es: 724, fi: 246, fr: 250, gb: 826, gr: 300, hk: 344, hr: 191, hu: 348, id: 360, ie: 372, il: 376, in: 356, it: 380,
  jp: 392, kr: 410, lt: 440, lv: 428, ma: 504, mx: 484, my: 458, ng: 566, nl: 528, no: 578, nz: 554, pe: 604, ph: 608, pk: 586,
  pl: 616, pt: 620, ro: 642, rs: 688, ru: 643, sa: 682, se: 752, sg: 702, sk: 703, th: 764, tr: 792, tw: 158, ua: 804, us: 840,
  vn: 704, za: 710,
};
const LANGUAGE: Record<string, string> = {
  ar: "es", at: "de", br: "pt", ch: "de", cl: "es", cn: "zh-CN", co: "es", cz: "cs", de: "de", dk: "da", eg: "ar", es: "es", fi: "fi",
  fr: "fr", gr: "el", hk: "zh-TW", hr: "hr", hu: "hu", id: "id", il: "he", it: "it", jp: "ja", kr: "ko", lt: "lt", lv: "lv", ma: "ar",
  mx: "es", nl: "nl", no: "no", pe: "es", pl: "pl", pt: "pt", ro: "ro", rs: "sr", ru: "ru", sa: "ar", se: "sv", sk: "sk", th: "th",
  tr: "tr", tw: "zh-TW", ua: "uk", vn: "vi",
};
/** Country-level location codes are 2000 + the ISO 3166-1 numeric code. */
export const locationCode = (country: string) => 2000 + (ISO_NUMERIC[country.toLowerCase()] ?? 840);
export const languageCode = (country: string) => LANGUAGE[country.toLowerCase()] ?? "en";

/** POST one task to a DataForSEO live endpoint. HTTP 200 can still carry a failed task, so both are checked. */
export async function dfsPost<T>(auth: DfsAuth, path: string, task: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<{ results: T[]; cost: number }> {
  const res = await fetcher(`https://api.dataforseo.com${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${auth.login}:${auth.password}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify([task]),
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 401) throw new Error("DataForSEO: wrong login or password (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD).");
  const json = (await res.json().catch(() => null)) as { status_code?: number; status_message?: string; cost?: number; tasks?: Array<{ status_code: number; status_message: string; result: T[] | null }> } | null;
  if (!res.ok || !json) throw new Error(`DataForSEO: HTTP ${res.status}`);
  const t = json.tasks?.[0];
  if (!t) throw new Error(`DataForSEO: ${json.status_code} ${json.status_message}`);
  if (t.status_code !== 20000 && t.status_code !== 20100) {
    if (t.status_code === 40200 || /payment|balance|funds/i.test(t.status_message)) throw new Error(`DataForSEO: ${t.status_message.replace(/\.$/, "")}. Add funds at app.dataforseo.com.`);
    throw new Error(`DataForSEO: ${t.status_code} ${t.status_message}`);
  }
  return { results: t.result ?? [], cost: json.cost ?? 0 };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const cell = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
const pipe = (s: string) => s.replace(/\|/g, "\\|");

export function bareDomain(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    // keep as is
  }
  return host.replace(/^www\./, "").replace(/\/.*$/, "");
}
const sameSite = (domain: string, own: string) => domain === own || domain.endsWith(`.${own}`);

/** The keywords to watch per storefront: web.keywords, else the store targets. */
export function webKeywords(project: Project): Record<string, string[]> {
  const own = project.spec.web?.keywords;
  const out: Record<string, string[]> = {};
  const countries = project.spec.web?.countries ?? Object.keys(own ?? {}).concat(Object.keys(project.spec.targets)).filter((c, i, a) => a.indexOf(c) === i).slice(0, 1);
  for (const cc of countries) {
    const list = own?.[cc] ?? project.spec.targets[cc] ?? [];
    if (list.length) out[cc] = [...new Set(list.map((k) => k.trim().toLowerCase()).filter(Boolean))];
  }
  return out;
}

export function siteDomain(project: Project): string {
  const url = project.spec.web?.url;
  if (!url) throw new Error("Set web.url in appeeky.spec.yaml first.");
  return bareDomain(url);
}

// ── ranks ───────────────────────────────────────────────────────────

interface SerpItem {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  url?: string;
  title?: string;
  items?: SerpItem[];
  references?: Array<{ url?: string; domain?: string }>;
}

export interface KeywordRank {
  country: string;
  keyword: string;
  /** The site's best organic position, null when not in the top 100. */
  position: number | null;
  url?: string;
  /** Where the app's own App Store or Google Play page ranks on Google. */
  storePosition: number | null;
  aiOverview: boolean;
  aiCitesYou: boolean;
  /** Domains the AI Overview cites. */
  aiCited: string[];
  top: string[];
}

export function readSerp(items: SerpItem[], own: string, storePatterns: RegExp[]): Omit<KeywordRank, "country" | "keyword"> {
  const organic = items.filter((i) => i.type === "organic" && i.url);
  const pos = (i: SerpItem) => i.rank_group ?? i.rank_absolute ?? 999;
  const mine = organic.filter((i) => sameSite(bareDomain(i.domain ?? i.url!), own)).sort((a, b) => pos(a) - pos(b))[0];
  const store = organic.filter((i) => storePatterns.some((p) => p.test(i.url!))).sort((a, b) => pos(a) - pos(b))[0];
  const block = items.find((i) => i.type === "ai_overview");
  const cited = new Set<string>();
  for (const ref of [...(block?.references ?? []), ...(block?.items ?? []).flatMap((x) => x.references ?? [])]) {
    const d = ref.domain ?? ref.url;
    if (d) cited.add(bareDomain(d));
  }
  const top = [...new Set(organic.sort((a, b) => pos(a) - pos(b)).map((i) => bareDomain(i.domain ?? i.url!)))].slice(0, 3);
  return {
    position: mine ? pos(mine) : null,
    ...(mine?.url ? { url: mine.url } : {}),
    storePosition: store ? pos(store) : null,
    aiOverview: Boolean(block),
    aiCitesYou: [...cited].some((d) => sameSite(d, own)),
    aiCited: [...cited].slice(0, 8),
    top,
  };
}

export const ranksFile = (root: string) => join(seoDir(root), "ranks.csv");
const RANKS_HEADER = "date,country,keyword,position,url,store_position,ai_overview,ai_cites_you\n";

interface RankRow {
  date: string;
  country: string;
  keyword: string;
  position: number | null;
  aiOverview: boolean;
  aiCitesYou: boolean;
}

async function readRanks(root: string): Promise<RankRow[]> {
  if (!existsSync(ranksFile(root))) return [];
  return (await readFile(ranksFile(root), "utf8"))
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const parts = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((p) => p.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
      return { date: parts[0]!, country: parts[1]!, keyword: parts[2]!, position: parts[3] ? Number(parts[3]) : null, aiOverview: parts[6] === "yes", aiCitesYou: parts[7] === "yes" };
    });
}

export async function daysSinceRanks(root: string, now = new Date()): Promise<number | null> {
  const last = (await readRanks(root)).map((r) => r.date).sort().at(-1);
  return last ? Math.floor((now.getTime() - Date.parse(last)) / 86_400_000) : null;
}

export interface RanksResult {
  ranks: KeywordRank[];
  costUsd: number;
  changes: string[];
  errors: string[];
}

/** One Google results page per keyword and storefront, read like a person on a phone sees it. */
export async function pullRanks(project: Project, auth: DfsAuth, options: { fetcher?: typeof fetch; now?: Date; log?: (l: string) => void } = {}): Promise<RanksResult> {
  const own = siteDomain(project);
  const ids = rankAppIds(project);
  const storePatterns = [
    ...(ids["app-store"] ? [new RegExp(`apps\\.apple\\.com/.*id${ids["app-store"]}`)] : []),
    ...(ids["google-play"] ? [new RegExp(`play\\.google\\.com/store/apps/details\\?id=${ids["google-play"].replace(/\./g, "\\.")}`)] : []),
  ];
  const device = project.spec.web?.device ?? "mobile";
  const now = options.now ?? new Date();
  const date = day(now);
  const ranks: KeywordRank[] = [];
  const errors: string[] = [];
  let cost = 0;
  for (const [country, keywords] of Object.entries(webKeywords(project))) {
    for (const keyword of keywords) {
      try {
        const { results, cost: c } = await dfsPost<{ items?: SerpItem[] }>(
          auth,
          "/v3/serp/google/organic/live/advanced",
          { keyword, location_code: locationCode(country), language_code: languageCode(country), device, os: device === "mobile" ? "ios" : "macos", depth: 100, load_async_ai_overview: true, group_organic_results: true },
          options.fetcher,
        );
        cost += c;
        ranks.push({ country, keyword, ...readSerp(results[0]?.items ?? [], own, storePatterns) });
      } catch (e) {
        errors.push(`${country.toUpperCase()} "${keyword}": ${(e as Error).message}`);
        if (/wrong login|Add funds/.test((e as Error).message)) break;
      }
      options.log?.(`${ranks.length + errors.length} keywords`);
    }
  }

  const dir = seoDir(project.root);
  await mkdir(dir, { recursive: true });
  const prev = await readRanks(project.root);
  const lastDate = prev.map((r) => r.date).filter((d) => d < date).sort().at(-1);
  const before = new Map(prev.filter((r) => r.date === lastDate).map((r) => [`${r.country}\u0000${r.keyword}`, r]));
  const changes: string[] = [];
  for (const r of ranks) {
    const was = before.get(`${r.country}\u0000${r.keyword}`);
    if (!was) continue;
    const label = `${r.country.toUpperCase()} "${r.keyword}"`;
    const top10 = (p: number | null) => p !== null && p <= 10;
    if (top10(r.position) && !top10(was.position)) changes.push(`${label}: into the top 10 (${was.position ?? "not ranked"} → ${r.position})`);
    if (!top10(r.position) && top10(was.position)) changes.push(`${label}: out of the top 10 (${was.position} → ${r.position ?? "not ranked"})`);
    if (r.aiCitesYou && !was.aiCitesYou) changes.push(`${label}: Google's AI Overview now cites the site`);
    if (!r.aiCitesYou && was.aiCitesYou) changes.push(`${label}: Google's AI Overview stopped citing the site`);
  }
  if (!existsSync(ranksFile(project.root))) await writeFile(ranksFile(project.root), RANKS_HEADER);
  // One snapshot a day: a second run the same day replaces the first.
  if (prev.some((r) => r.date === date)) {
    const kept = (await readFile(ranksFile(project.root), "utf8")).split("\n").filter((l, i) => i === 0 || (l && !l.startsWith(`${date},`)));
    await writeFile(ranksFile(project.root), kept.join("\n") + "\n");
  }
  const yes = (b: boolean) => (b ? "yes" : "no");
  if (ranks.length) await appendFile(ranksFile(project.root), ranks.map((r) => [date, r.country, cell(r.keyword), r.position ?? "", cell(r.url ?? ""), r.storePosition ?? "", yes(r.aiOverview), yes(r.aiCitesYou)].join(",")).join("\n") + "\n");

  const ranked = ranks.filter((r) => r.position !== null);
  const md = [
    "# Google ranks",
    "",
    `Written by \`seo ranks\` from DataForSEO, ${date}, ${device}. ${own}: ${ranked.length} of ${ranks.length} keywords in the top 100, ${ranks.filter((r) => r.position !== null && r.position <= 10).length} in the top 10. Google's AI Overview shows for ${ranks.filter((r) => r.aiOverview).length} and cites the site for ${ranks.filter((r) => r.aiCitesYou).length}.`,
    "",
    "| keyword | site | store page | AI Overview | top 3 |",
    "| --- | --- | --- | --- | --- |",
    ...ranks.map(
      (r) =>
        `| ${r.country.toUpperCase()} ${pipe(r.keyword)} | ${r.position ?? "—"} | ${r.storePosition ?? "—"} | ${r.aiOverview ? (r.aiCitesYou ? "cites you" : `cites ${r.aiCited.slice(0, 3).join(", ") || "no one"}`) : "—"} | ${r.top.join(", ")} |`,
    ),
    "",
    "`site` is the best position of a page on the site, `store page` is where the app's App Store or Google Play page ranks on Google.",
    "",
  ].join("\n");
  await writeFile(join(dir, "ranks.md"), md);
  if (changes.length) {
    const file = join(dir, "changes.md");
    const old = existsSync(file) ? await readFile(file, "utf8") : "# Google changes\n\nWritten by `seo ranks`: keywords that entered or left the top 10, and AI Overview citations.\n";
    const [head, ...rest] = old.split(/\n(?=- )/);
    await writeFile(file, [head!.trimEnd(), "", ...changes.map((c) => `- ${date} · ${c}`), ...rest.map((r) => r.trimEnd())].join("\n") + "\n");
  }
  return { ranks, costUsd: r4(cost), changes, errors };
}

/** `web_rank` (average position, 101 for not ranked) and `ai_overview_citations` (share of keywords) per scan day. */
export function webRankMetricSource(root: string): MetricSource | null {
  if (!existsSync(ranksFile(root))) return null;
  let rows: Promise<RankRow[]> | undefined;
  return {
    label: "Google ranks in the repo",
    async window(_store, _appId, from, to) {
      rows ??= readRanks(root);
      const inside = (await rows).filter((r) => r.date >= from && r.date < to);
      if (inside.length === 0) return null;
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
      const values: MetricWindow["values"] = {
        web_rank: inside.reduce((n, r) => n + (r.position ?? 101), 0) / inside.length,
        ai_overview_citations: inside.filter((r) => r.aiCitesYou).length / inside.length,
      };
      return { from, to, days, values };
    },
  };
}

// ── keywords ────────────────────────────────────────────────────────

interface LabsItem {
  keyword?: string;
  keyword_data?: { keyword?: string; keyword_info?: KeywordInfo; keyword_properties?: { keyword_difficulty?: number | null }; search_intent_info?: { main_intent?: string | null } };
  keyword_info?: KeywordInfo;
  keyword_properties?: { keyword_difficulty?: number | null };
  search_intent_info?: { main_intent?: string | null };
  ranked_serp_element?: { serp_item?: { rank_group?: number | null; url?: string | null; etv?: number | null } };
}
interface KeywordInfo {
  search_volume?: number | null;
  cpc?: number | null;
}

export interface KeywordRow {
  country: string;
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string | null;
  tracked: boolean;
}

function flat(item: LabsItem) {
  const n = item.keyword_data;
  return {
    keyword: (n?.keyword ?? item.keyword ?? "").toLowerCase(),
    volume: n?.keyword_info?.search_volume ?? item.keyword_info?.search_volume ?? null,
    cpc: n?.keyword_info?.cpc ?? item.keyword_info?.cpc ?? null,
    difficulty: n?.keyword_properties?.keyword_difficulty ?? item.keyword_properties?.keyword_difficulty ?? null,
    intent: n?.search_intent_info?.main_intent ?? item.search_intent_info?.main_intent ?? null,
    position: item.ranked_serp_element?.serp_item?.rank_group ?? null,
    url: item.ranked_serp_element?.serp_item?.url ?? null,
    traffic: item.ranked_serp_element?.serp_item?.etv ?? null,
  };
}

/** Volume, difficulty, CPC and intent for the watched keywords, and related ideas from the first few. */
export async function pullKeywords(project: Project, auth: DfsAuth, options: { fetcher?: typeof fetch; seeds?: number } = {}): Promise<{ rows: KeywordRow[]; costUsd: number }> {
  const rows: KeywordRow[] = [];
  let cost = 0;
  for (const [country, keywords] of Object.entries(webKeywords(project))) {
    const base = { location_code: locationCode(country), language_code: languageCode(country) };
    const overview = await dfsPost<{ items?: LabsItem[] }>(auth, "/v3/dataforseo_labs/google/keyword_overview/live", { ...base, keywords: keywords.slice(0, 700) }, options.fetcher);
    cost += overview.cost;
    const seen = new Set<string>();
    const got = new Map((overview.results[0]?.items ?? []).map((i) => [flat(i).keyword, flat(i)]));
    for (const k of keywords) {
      const f = got.get(k);
      seen.add(k);
      rows.push({ country, keyword: k, volume: f?.volume ?? null, difficulty: f?.difficulty ?? null, cpc: f?.cpc ?? null, intent: f?.intent ?? null, tracked: true });
    }
    for (const seed of keywords.slice(0, options.seeds ?? 3)) {
      const related = await dfsPost<{ items?: LabsItem[] }>(
        auth,
        "/v3/dataforseo_labs/google/related_keywords/live",
        { ...base, keyword: seed, depth: 1, limit: 50, order_by: ["keyword_data.keyword_info.search_volume,desc"] },
        options.fetcher,
      );
      cost += related.cost;
      for (const i of related.results[0]?.items ?? []) {
        const f = flat(i);
        if (!f.keyword || seen.has(f.keyword)) continue;
        seen.add(f.keyword);
        rows.push({ country, keyword: f.keyword, volume: f.volume, difficulty: f.difficulty, cpc: f.cpc, intent: f.intent, tracked: false });
      }
    }
  }
  const dir = seoDir(project.root);
  await mkdir(dir, { recursive: true });
  const sorted = [...rows].sort((a, b) => Number(b.tracked) - Number(a.tracked) || (b.volume ?? -1) - (a.volume ?? -1));
  await writeFile(
    join(dir, "keywords.csv"),
    `country,keyword,volume,difficulty,cpc,intent,tracked\n${sorted.map((r) => [r.country, cell(r.keyword), r.volume ?? "", r.difficulty ?? "", r.cpc ?? "", r.intent ?? "", r.tracked ? "yes" : "no"].join(",")).join("\n")}\n`,
  );
  return { rows: sorted, costUsd: r4(cost) };
}

// ── domain ──────────────────────────────────────────────────────────

export interface DomainReport {
  domain: string;
  country: string;
  keywords: number;
  traffic: number;
  top3: number;
  top10: number;
  ranked: Array<{ keyword: string; position: number | null; volume: number | null; url: string | null; traffic: number | null }>;
  competitors: Array<{ domain: string; common: number; avgPosition: number | null }>;
}

const PLATFORMS = /(^|\.)(google\.|apple\.com$|youtube\.com$|wikipedia\.org$|facebook\.com$|reddit\.com$|amazon\.|linkedin\.com$|twitter\.com$|x\.com$|instagram\.com$|tiktok\.com$|medium\.com$|github\.com$)/;

/** What the site ranks for in the first storefront, and the sites that rank for the same searches. */
export async function pullDomain(project: Project, auth: DfsAuth, options: { fetcher?: typeof fetch } = {}): Promise<{ report: DomainReport; costUsd: number }> {
  const domain = siteDomain(project);
  const country = Object.keys(webKeywords(project))[0] ?? Object.keys(project.spec.targets)[0] ?? "us";
  const target = { target: domain, location_code: locationCode(country), language_code: languageCode(country) };
  let cost = 0;
  const overview = await dfsPost<{ items?: Array<{ metrics?: { organic?: Record<string, number> } }> }>(auth, "/v3/dataforseo_labs/google/domain_rank_overview/live", target, options.fetcher);
  cost += overview.cost;
  const o = overview.results[0]?.items?.[0]?.metrics?.organic ?? {};
  const ranked = await dfsPost<{ items?: LabsItem[] }>(auth, "/v3/dataforseo_labs/google/ranked_keywords/live", { ...target, limit: 100, order_by: ["ranked_serp_element.serp_item.etv,desc"] }, options.fetcher);
  cost += ranked.cost;
  const competitors = await dfsPost<{ items?: Array<{ domain?: string; intersections?: number; avg_position?: number }> }>(auth, "/v3/dataforseo_labs/google/competitors_domain/live", { ...target, limit: 30 }, options.fetcher);
  cost += competitors.cost;
  const report: DomainReport = {
    domain,
    country,
    keywords: o.count ?? 0,
    traffic: Math.round(o.etv ?? 0),
    top3: (o.pos_1 ?? 0) + (o.pos_2_3 ?? 0),
    top10: (o.pos_1 ?? 0) + (o.pos_2_3 ?? 0) + (o.pos_4_10 ?? 0),
    ranked: (ranked.results[0]?.items ?? []).map((i) => {
      const f = flat(i);
      return { keyword: f.keyword, position: f.position, volume: f.volume, url: f.url, traffic: f.traffic === null ? null : Math.round(f.traffic) };
    }),
    competitors: (competitors.results[0]?.items ?? [])
      .filter((c) => c.domain && bareDomain(c.domain) !== domain && !PLATFORMS.test(bareDomain(c.domain)))
      .slice(0, 10)
      .map((c) => ({ domain: bareDomain(c.domain!), common: c.intersections ?? 0, avgPosition: c.avg_position === undefined ? null : r2(c.avg_position) })),
  };
  const dir = seoDir(project.root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "ranked-keywords.csv"),
    `keyword,position,volume,traffic,url\n${report.ranked.map((r) => [cell(r.keyword), r.position ?? "", r.volume ?? "", r.traffic ?? "", cell(r.url ?? "")].join(",")).join("\n")}${report.ranked.length ? "\n" : ""}`,
  );
  const targets = new Set(Object.values(project.spec.targets).flat().map((t) => t.toLowerCase()));
  const md = [
    "# The site in Google",
    "",
    `Written by \`seo domain\` from DataForSEO for ${domain} in ${country.toUpperCase()}.`,
    "",
    `- Ranks for ${report.keywords} keywords: ${report.top3} in the top 3, ${report.top10} in the top 10`,
    `- Estimated organic visits a month: ${report.traffic}`,
    "",
    "## Top keywords",
    "",
    "| keyword | position | volume | store target |",
    "| --- | --- | --- | --- |",
    ...(report.ranked.length ? report.ranked.slice(0, 20).map((r) => `| ${pipe(r.keyword)} | ${r.position ?? "—"} | ${r.volume ?? "—"} | ${targets.has(r.keyword) ? "yes" : ""} |`) : ["| none yet | | | |"]),
    "",
    "## Sites that rank for the same searches",
    "",
    "| domain | shared keywords | their average position |",
    "| --- | --- | --- |",
    ...(report.competitors.length ? report.competitors.map((c) => `| ${c.domain} | ${c.common} | ${c.avgPosition ?? "—"} |`) : ["| none found | | |"]),
    "",
  ].join("\n");
  await writeFile(join(dir, "domain.md"), md);
  return { report, costUsd: r4(cost) };
}

/** USD before anything is asked. */
export function quoteSeo(project: Project, what: "ranks" | "keywords" | "domain", seeds = 3): number {
  const sets = Object.values(webKeywords(project));
  if (what === "ranks") return r2(sets.reduce((n, k) => n + k.length, 0) * DFS_PRICE.serp);
  if (what === "keywords") return r2(sets.reduce((n, k) => n + DFS_PRICE.keywordOverview + Math.min(seeds, k.length) * DFS_PRICE.related, 0));
  return r2(DFS_PRICE.domain);
}

/** For tests and callers that only want the latest snapshot. */
export async function latestRanks(root: string): Promise<RankRow[]> {
  const rows = await readRanks(root);
  const last = rows.map((r) => r.date).sort().at(-1);
  return rows.filter((r) => r.date === last);
}
