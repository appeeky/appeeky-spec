import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppeekyApi } from "./appeeky-api.js";
import type { AttributionClient, AttributionClients, BreakdownRow, LinkStats, Summary } from "./attribution.js";
import { SPEC_DIR } from "./files.js";
import type { MetaInsightRow } from "./metrics.js";
import type { Project, StoreId } from "./schema.js";
import { rankAppIds } from "./verify.js";

/**
 * Your app's numbers as plain CSV files an agent can read: the same sources Appeeky
 * Desktop keeps locally (App Store Connect and Google Play analytics, Apple Search Ads,
 * RevenueCat, Meta and TikTok), pulled through the connections in Appeeky.
 *
 * They are private business data, so they go to .appeeky/data/ (gitignored) unless the
 * spec says `data: { commit: true }`, which writes them to appeeky/data/ instead.
 * Pulling again merges by date, so a scheduled pull keeps one growing file per source.
 */

export function dataDir(project: Project): string {
  return project.spec.data.commit ? join(project.root, SPEC_DIR, "data") : join(project.root, ".appeeky", "data");
}

type Row = Record<string, string | number | null | undefined>;

export interface DataFile {
  name: string;
  /** What it holds, for the index. */
  about: string;
  key: string[];
  columns: string[];
  rows: Row[];
}

function cell(v: Row[string]): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(Math.round(v * 10_000) / 10_000) : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text: string): Row[] {
  const [head, ...lines] = text.trim().split("\n");
  if (!head) return [];
  const cols = head.split(",");
  return lines.map((line) => {
    const vals: string[] = [];
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
        vals.push(cur);
        cur = "";
      } else cur += ch;
    }
    vals.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, vals[i] ?? ""]));
  });
}

/** Merge rows into a CSV file by key: new rows replace old ones with the same key. */
export async function mergeCsv(dir: string, file: DataFile): Promise<{ path: string; rows: number; from?: string; to?: string }> {
  const path = join(dir, `${file.name}.csv`);
  const keyOf = (r: Row) => file.key.map((k) => String(r[k] ?? "")).join("|");
  const merged = new Map<string, Row>();
  if (existsSync(path)) for (const r of parseCsv(await readFile(path, "utf8"))) merged.set(keyOf(r), r);
  for (const r of file.rows) merged.set(keyOf(r), r);
  const rows = [...merged.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  await mkdir(dir, { recursive: true });
  await writeFile(path, [file.columns.join(","), ...rows.map((r) => file.columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n");
  const dates = rows.map((r) => String(r.date ?? "")).filter(Boolean).sort();
  return { path, rows: rows.length, from: dates[0], to: dates[dates.length - 1] };
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** [from, to] inclusive, split into chunks the API accepts. */
export function dateChunks(from: string, to: string, maxDays = 180): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = Date.parse(from);
  const end = Date.parse(to);
  while (start <= end) {
    const stop = Math.min(end, start + (maxDays - 1) * 86_400_000);
    out.push([iso(start), iso(stop)]);
    start = stop + 86_400_000;
  }
  return out;
}

interface UserMetrics {
  store: { source: string; days: Array<Record<string, number | string | null>> } | null;
  sources: Array<{ source: string; impressions: number; pageViews: number; share: number }> | null;
  ads: { currency: string | null; days: Array<{ date: string; spend: number; impressions: number; taps: number; installs: number }> } | null;
  revenuecat: { scope: "app" | "project"; currency: string | null; days: Array<Record<string, number | string | null>> } | null;
}

export interface PullResult {
  files: Array<{ name: string; path: string; rows: number; from?: string; to?: string; about: string }>;
  errors: Array<{ source: string; message: string }>;
}

/** Every source this spec can read, over the `days` up to yesterday. */
export async function pullData(api: AppeekyApi | undefined, project: Project, days: number, now = new Date(), attributionIn?: AttributionClient | AttributionClients): Promise<PullResult> {
  const to = iso(now.getTime() - 86_400_000);
  const from = iso(Date.parse(to) - (Math.max(1, days) - 1) * 86_400_000);
  const ids = rankAppIds(project);
  const files: DataFile[] = [];
  const errors: PullResult["errors"] = [];
  const attempt = async (source: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      errors.push({ source, message: (e as Error).message });
    }
  };

  for (const store of (api ? Object.keys(ids) : []) as StoreId[]) {
    if (!api) break;
    const appId = ids[store]!;
    const label = store === "app-store" ? "App Store Connect" : "Google Play";
    await attempt(`${label} analytics`, async () => {
      const storeRows: Row[] = [];
      const adRows: Row[] = [];
      const rcRows: Row[] = [];
      let sources: UserMetrics["sources"] = null;
      let rcScope: string | undefined;
      for (const [a, b] of dateChunks(from, to)) {
        const m = await api.get<UserMetrics>(`/user/apps/${encodeURIComponent(appId)}/metrics`, { from: a, to: b });
        for (const d of m?.store?.days ?? []) storeRows.push({ ...d, date: String(d.date) });
        for (const d of m?.ads?.days ?? []) adRows.push({ ...d, currency: m?.ads?.currency });
        for (const d of m?.revenuecat?.days ?? []) rcRows.push({ ...d, date: String(d.date) });
        if (m?.sources) sources = m.sources;
        rcScope = m?.revenuecat?.scope ?? rcScope;
      }
      if (storeRows.length)
        files.push({
          name: `${store}-analytics`,
          about: `${label}: impressions, product page views, downloads, conversion, proceeds, trials and subscriptions per day`,
          key: ["date"],
          columns: ["date", "impressions", "pageViews", "downloads", "conversionRate", "proceeds", "trials", "subscriptions"],
          rows: storeRows,
        });
      if (sources?.length)
        files.push({
          name: `${store}-traffic-sources`,
          about: `${label}: where product page views came from, ${from} to ${to} (replaced on every pull)`,
          key: ["source"],
          columns: ["source", "impressions", "pageViews", "share"],
          rows: sources,
        });
      if (adRows.length && store === "app-store")
        files.push({
          name: "apple-search-ads",
          about: "Apple Search Ads: spend, impressions, taps and installs per day",
          key: ["date"],
          columns: ["date", "spend", "impressions", "taps", "installs", "currency"],
          rows: adRows,
        });
      if (rcRows.length && !files.some((f) => f.name === "revenuecat"))
        files.push({
          name: "revenuecat",
          about: `RevenueCat: revenue, MRR, trials, new customers, trial conversion, churn and actives per day${rcScope === "project" ? " (the RevenueCat project holds other apps too, so these include them)" : ""}`,
          key: ["date"],
          columns: ["date", "revenue", "mrr", "trials", "newCustomers", "trialConversion", "churn", "actives"],
          rows: rcRows,
        });
    });
  }

  if (api && ids["app-store"]) {
    await attempt("App Store Connect sales", async () => {
      const m = await api.get<{ daily?: Array<Record<string, number | string>>; countries?: Array<{ country: string; downloads: number; revenue: number }> }>(
        `/connect/metrics/apps/${encodeURIComponent(ids["app-store"]!)}`,
        { from, to },
      );
      if (m?.daily?.length)
        files.push({
          name: "app-store-sales",
          about: "App Store Connect sales reports: units, revenue, subscriptions, trials and in-app purchases per day",
          key: ["date"],
          columns: ["date", "downloads", "revenue", "subscriptions", "trials", "iap_count"],
          rows: m.daily.map((d) => ({ ...d, date: String(d.metric_date) })),
        });
      if (m?.countries?.length)
        files.push({
          name: "app-store-countries",
          about: `App Store Connect: downloads and revenue by country, ${from} to ${to} (replaced on every pull)`,
          key: ["country"],
          columns: ["country", "downloads", "revenue"],
          rows: m.countries,
        });
    });
  }

  // One set of files per Appeeky Analytics app; with an app per store, the store is in the name.
  const attributionByStore: [string, AttributionClient][] = !attributionIn
    ? []
    : "get" in attributionIn
      ? [["", attributionIn as AttributionClient]]
      : [...new Map(Object.entries(attributionIn as AttributionClients).map(([store, client]) => [client, store])).entries()].map(([client, store]) => [store, client!]);
  for (const [store, attribution] of attributionByStore) {
    const suffix = attributionByStore.length > 1 ? `-${store}` : "";
    await attempt(attribution.label, async () => {
      const summary = await attribution.get<Summary>("summary", { days: String(Math.min(180, Math.max(1, days))) });
      if (summary?.bySource?.length)
        files.push({
          name: `attribution-sources${suffix}`,
          about: `Installs, trials, payers and revenue by source and campaign, for installs in the last ${summary.days} days (replaced on every pull)`,
          key: ["source", "campaign"],
          columns: ["source", "campaign", "installs", "trials", "payers", "revenueUsd"],
          rows: summary.bySource.map((r) => ({ ...r })),
        });
      for (const dim of ["keyword", "campaign", "country"] as const) {
        const rows = await attribution.get<BreakdownRow[] | { rows?: BreakdownRow[] }>("breakdown", { dim, range: "30d" });
        const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
        // Apple Search Ads reports keyword ids, not the words; the words are in your Search Ads account.
        const column = dim === "keyword" ? "keywordId" : dim;
        if (list.length)
          files.push({
            name: `attribution-${dim === "country" ? "countries" : `${dim}s`}${suffix}`,
            about: `Installs, payers and revenue by ${dim === "keyword" ? "Apple Search Ads keyword id" : dim === "campaign" ? "campaign ((none) is organic and other installs without one)" : dim}, last 30 days (replaced on every pull)`,
            key: [column],
            columns: [column, "installs", "payers", "revenueUsd"],
            rows: list.map((r) => ({ [column]: r.key ?? "(none)", installs: r.count, payers: r.payers, revenueUsd: r.revenueUsd })),
          });
      }
      const links = await attribution.get<{ links?: LinkStats[] }>("links", { range: "30d" });
      if (links?.links?.length)
        files.push({
          name: `smart-links${suffix}`,
          about: "Smart links: clicks, installs and revenue per link, last 30 days (replaced on every pull)",
          key: ["slug"],
          columns: ["slug", "name", "campaign", "channel", "clicks", "installs", "revenueUsd"],
          rows: links.links.map((l) => ({ slug: l.link.slug, name: l.link.name, campaign: l.link.campaign, channel: l.link.channel, clicks: l.clicks.total, installs: l.installs, revenueUsd: l.revenueUsd })),
        });
    });
  }

  const meta = project.spec.ads.meta;
  if (api && meta) {
    await attempt("Meta Ads", async () => {
      const rows: Row[] = [];
      for (const campaign of meta.campaigns) {
        const data = await api.get<{ data?: Array<MetaInsightRow & { date_start?: string; impressions?: string; clicks?: string }> }>("/connect/meta-ads/insights", {
          targetType: "campaign",
          targetId: campaign,
          since: from,
          until: to,
          timeIncrement: "1",
          fields: "spend,impressions,clicks,actions,date_start",
          ...(meta.adAccount ? { adAccountId: meta.adAccount } : {}),
        });
        for (const r of data?.data ?? []) {
          const installs = (r.actions ?? []).find((a) => ["mobile_app_install", "app_install", "omni_app_install"].includes(a.action_type));
          rows.push({ date: r.date_start, campaign, spend: Number(r.spend ?? 0), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), installs: Number(installs?.value ?? 0) });
        }
      }
      if (rows.length) files.push({ name: "meta-ads", about: "Meta Ads: spend, impressions, clicks and installs per campaign per day", key: ["date", "campaign"], columns: ["date", "campaign", "spend", "impressions", "clicks", "installs"], rows });
    });
  }

  const tiktok = project.spec.ads.tiktok;
  if (api && tiktok) {
    await attempt("TikTok Ads", async () => {
      const data = await api.get<{ list?: Array<{ dimensions?: { campaign_id?: string; stat_time_day?: string }; metrics?: Record<string, string> }> }>("/connect/tiktok-ads/report", {
        dataLevel: "AUCTION_CAMPAIGN",
        dimensions: "campaign_id,stat_time_day",
        metrics: "spend,impressions,clicks,conversion",
        startDate: from,
        endDate: to,
        pageSize: "1000",
        ...(tiktok.advertiser ? { advertiserId: tiktok.advertiser } : {}),
      });
      const rows = (data?.list ?? [])
        .filter((r) => r.dimensions?.campaign_id && tiktok.campaigns.includes(String(r.dimensions.campaign_id)))
        .map((r) => ({
          date: String(r.dimensions?.stat_time_day ?? "").slice(0, 10),
          campaign: String(r.dimensions?.campaign_id),
          spend: Number(r.metrics?.spend ?? 0),
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          conversions: Number(r.metrics?.conversion ?? 0),
        }));
      if (rows.length) files.push({ name: "tiktok-ads", about: "TikTok Ads: spend, impressions, clicks and conversions per campaign per day", key: ["date", "campaign"], columns: ["date", "campaign", "spend", "impressions", "clicks", "conversions"], rows });
    });
  }

  const dir = dataDir(project);
  const written: PullResult["files"] = [];
  for (const f of files) {
    // Range snapshots are replaced, daily series are merged.
    if (!f.key.includes("date") && existsSync(join(dir, `${f.name}.csv`))) await writeFile(join(dir, `${f.name}.csv`), "");
    written.push({ name: f.name, about: f.about, ...(await mergeCsv(dir, f)) });
  }
  if (written.length) await writeIndex(dir, written, now);
  return { files: written, errors };
}

/** README.md next to the files: what each one holds, so an agent knows where to look. */
async function writeIndex(dir: string, files: PullResult["files"], now: Date): Promise<void> {
  const lines = [
    "# App data",
    "",
    `Pulled ${now.toISOString().slice(0, 10)} by \`appeeky-spec data pull\`. Daily files are merged by date on every pull. Do not edit by hand.`,
    "",
    "| file | rows | dates | what it holds |",
    "| --- | --- | --- | --- |",
    ...files.map((f) => `| ${f.name}.csv | ${f.rows} | ${f.from && f.to ? `${f.from} → ${f.to}` : "—"} | ${f.about} |`),
    "",
  ];
  await writeFile(join(dir, "README.md"), lines.join("\n"));
}
