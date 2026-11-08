import { createPrivateKey, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_DIR } from "./files.js";
import { defaultRunner, onPath, STORE_CLIS, type Runner } from "./transport.js";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { Project } from "./schema.js";

/**
 * Apple Search Ads on your own API key, no Appeeky account: the app's campaigns, spend and installs
 * per day, and the keywords and search terms that brought installs, in appeeky/search-ads/.
 *
 * Make the key in Apple Search Ads → Account Settings → API (an API user with a read role), then set
 * ASA_CLIENT_ID, ASA_TEAM_ID, ASA_KEY_ID and ASA_PRIVATE_KEY (the PEM, or a path to it), next to the
 * App Store Connect key. The org comes from stores.appStore.searchAds.orgId (or ASA_ORG_ID) when the key
 * reaches more than one organization.
 */

const TOKEN_URL = "https://appleid.apple.com/auth/oauth2/token";
const API = "https://api.searchads.apple.com/api/v5";

export const searchAdsDir = (root: string) => join(root, SPEC_DIR, "search-ads");

export interface SearchAdsCredentials {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  orgId?: string;
}

const env1 = (env: Record<string, string | undefined>, ...names: string[]) => names.map((n) => env[n]?.trim()).find(Boolean);

/** ASA_* (or the APPLE_SEARCH_ADS_* spelling); null when no key is set. */
export async function readSearchAdsCredentials(env: Record<string, string | undefined>, orgId?: string): Promise<SearchAdsCredentials | null> {
  const clientId = env1(env, "ASA_CLIENT_ID", "APPLE_SEARCH_ADS_CLIENT_ID");
  const keyId = env1(env, "ASA_KEY_ID", "APPLE_SEARCH_ADS_KEY_ID");
  const rawKey = env1(env, "ASA_PRIVATE_KEY", "APPLE_SEARCH_ADS_PRIVATE_KEY");
  if (!clientId && !keyId && !rawKey) return null;
  const missing = [!clientId && "ASA_CLIENT_ID", !keyId && "ASA_KEY_ID", !rawKey && "ASA_PRIVATE_KEY"].filter(Boolean);
  if (missing.length) throw new Error(`Apple Search Ads needs ${missing.join(", ")} too.`);
  const privateKey = rawKey!.includes("BEGIN") ? rawKey!.replace(/\\n/g, "\n") : existsSync(rawKey!) ? await readFile(rawKey!, "utf8") : rawKey!;
  return {
    clientId: clientId!,
    teamId: env1(env, "ASA_TEAM_ID", "APPLE_SEARCH_ADS_TEAM_ID") ?? clientId!,
    keyId: keyId!,
    privateKey,
    orgId: orgId ?? env1(env, "ASA_ORG_ID", "APPLE_SEARCH_ADS_ORG_ID"),
  };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** The client secret Apple wants: a JWT signed with the API key (ES256). */
export function clientSecret(creds: SearchAdsCredentials, now = new Date()): string {
  let key;
  try {
    key = createPrivateKey(creds.privateKey);
  } catch {
    throw new Error("ASA_PRIVATE_KEY is not a private key: use the EC private key PEM you made for the API user, not the public key you uploaded to Apple.");
  }
  const iat = Math.floor(now.getTime() / 1000);
  const input = `${b64url(JSON.stringify({ alg: "ES256", kid: creds.keyId, typ: "JWT" }))}.${b64url(JSON.stringify({ sub: creds.clientId, aud: "https://appleid.apple.com", iss: creds.teamId, iat, exp: iat + 3000 }))}`;
  return `${input}.${b64url(sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }))}`;
}

/** One Search Ads API call: returns Apple's JSON body, or throws with Apple's message. */
export type SearchAdsRequest = (method: string, path: string, body?: unknown) => Promise<{ data?: unknown }>;

function appleError(status: number, json: { error?: { errors?: Array<{ message?: string; field?: string }> } }, path: string): Error {
  const e = json.error?.errors?.[0];
  return new Error(`Apple Search Ads: ${e ? [e.message, e.field && `(${e.field})`].filter(Boolean).join(" ") : `HTTP ${status}`} on ${path.split("?")[0]}`);
}

/** Calls Apple directly with a key from the environment (ASA_*). */
export function directRequest(creds: SearchAdsCredentials, fetcher: typeof fetch = fetch): { request: SearchAdsRequest; org: () => Promise<string> } {
  let token: string | undefined;
  let orgId = creds.orgId;
  const accessToken = async () => {
    if (token) return token;
    const res = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: clientSecret(creds), scope: "searchadsorg" }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`Apple Search Ads sign-in failed: ${body.error ?? res.status}. Check ASA_CLIENT_ID, ASA_TEAM_ID, ASA_KEY_ID and the private key.`);
    token = body.access_token;
    return token;
  };
  const raw = async (method: string, path: string, body: unknown, withOrg: boolean) => {
    const headers: Record<string, string> = { authorization: `Bearer ${await accessToken()}`, accept: "application/json" };
    if (withOrg) headers["x-ap-context"] = `orgId=${await org()}`;
    if (body) headers["content-type"] = "application/json";
    const res = await fetcher(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let json: { data?: unknown; error?: { errors?: Array<{ message?: string; field?: string }> } } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // not JSON
    }
    if (!res.ok) throw appleError(res.status, json, path);
    return json;
  };
  const org = async (): Promise<string> => {
    if (orgId) return orgId;
    const acls = ((await raw("GET", "/acls", undefined, false)).data ?? []) as Array<{ orgId: number | string; orgName?: string }>;
    const ids = [...new Set(acls.map((a) => String(a.orgId)))];
    if (ids.length !== 1) throw new Error(ids.length ? `The key reaches ${ids.length} organizations (${acls.map((a) => `${a.orgId} ${a.orgName ?? ""}`.trim()).join(", ")}). Set stores.appStore.searchAds.orgId.` : "The key reaches no Apple Search Ads organization.");
    orgId = ids[0]!;
    return orgId;
  };
  return { request: (method, path, body) => raw(method, path, body, path !== "/acls"), org };
}

/**
 * Calls Apple through the App Store Connect CLI (`appstore search-ads call`), with the Search Ads key
 * saved on an account next to its App Store Connect key, so the private key never leaves the CLI:
 *   appstore accounts search-ads <account> --client-id … --team-id … --key-id … --private-key-path …
 */
export function cliRequest(options: { account?: string; orgId?: string; runner?: Runner; useNpx?: boolean } = {}): { request: SearchAdsRequest; org: () => Promise<string> } {
  const cli = STORE_CLIS["app-store"];
  const run = async (args: string[]) => {
    const argv = ["--json", ...(options.account ? ["--account", options.account] : []), "search-ads", ...args];
    const useNpx = options.useNpx ?? !onPath(cli.bin);
    const [command, full] = useNpx ? ["npx", ["-y", "-p", cli.npmPackage, cli.bin, ...argv]] : [cli.bin, argv];
    let r;
    try {
      r = await (options.runner ?? defaultRunner)(command, full);
    } catch (e) {
      throw new Error(`Could not start ${command}: ${(e as Error).message}`);
    }
    if (r.code !== 0) {
      let message = r.stderr.trim().split("\n").at(-1) ?? "";
      try {
        message = (JSON.parse(r.stdout) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // stderr has the message
      }
      if (/unknown command|search-ads/i.test(message) && !/Search Ads/.test(message)) message += " Update the App Store Connect CLI: npm install -g @appeeky/app-store-connect-cli@latest";
      throw new Error(message || `appstore search-ads exited with ${r.code}`);
    }
    return JSON.parse(r.stdout) as { data?: unknown };
  };
  let orgId = options.orgId;
  return {
    request: (method, path, body) => run(["call", method, `/api/v5${path}`, ...(body ? [JSON.stringify(body)] : []), ...(options.orgId ? ["--org-id", options.orgId] : [])]),
    org: async () => {
      if (orgId) return orgId;
      const orgs = (await run(["orgs"])) as unknown;
      const list = (Array.isArray(orgs) ? orgs : ((orgs as { data?: unknown[] }).data ?? [])) as Array<{ orgId: number | string }>;
      orgId = list.length === 1 ? String(list[0]!.orgId) : "the account's org";
      return orgId;
    },
  };
}

/**
 * Where the Search Ads key comes from: ASA_* in the environment (called directly), else the
 * App Store Connect CLI account in stores.appStore.account (or its default account).
 */
export async function searchAdsSource(project: Project, env: Record<string, string | undefined> = process.env, runner?: Runner) {
  const cfg = project.spec.stores.appStore;
  const creds = await readSearchAdsCredentials(env, cfg?.searchAds?.orgId);
  if (creds) return { label: "ASA_* key", source: creds };
  return { label: `appstore CLI${cfg?.account ? ` account ${cfg.account}` : ""}`, source: cliRequest({ account: cfg?.account, orgId: cfg?.searchAds?.orgId, runner }) };
}

export class SearchAdsClient {
  private readonly request: SearchAdsRequest;
  private readonly resolveOrg: () => Promise<string>;
  /** A key from the environment (calls Apple directly), or another way to call it, such as the appstore CLI. */
  constructor(source: SearchAdsCredentials | { request: SearchAdsRequest; org: () => Promise<string> }, fetcher: typeof fetch = fetch) {
    const via = "request" in source ? source : directRequest(source, fetcher);
    this.request = via.request;
    this.resolveOrg = via.org;
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return (await this.request(init.method ?? "GET", path, init.body)).data as T;
  }

  /** The organization the calls go to. */
  async org(): Promise<string> {
    return this.resolveOrg();
  }

  async campaigns(): Promise<Campaign[]> {
    return (await this.call<Campaign[]>("/campaigns?limit=1000")) ?? [];
  }

  /** Per campaign and day. */
  async daily(from: string, to: string): Promise<CampaignReportRow[]> {
    const data = await this.call<{ reportingDataResponse?: { row?: CampaignReportRow[] } }>("/reports/campaigns", {
      method: "POST",
      body: { startTime: from, endTime: to, granularity: "DAILY", timeZone: "UTC", returnRecordsWithNoMetrics: false, returnRowTotals: false, returnGrandTotals: false, selector: { orderBy: [{ field: "campaignId", sortOrder: "ASCENDING" }], pagination: { offset: 0, limit: 1000 } } },
    });
    return data?.reportingDataResponse?.row ?? [];
  }

  /** Totals per keyword (or per search term) for one campaign. */
  async totals(campaignId: number | string, kind: "keywords" | "searchterms", from: string, to: string): Promise<TotalsRow[]> {
    const data = await this.call<{ reportingDataResponse?: { row?: TotalsRow[] } }>(`/reports/campaigns/${campaignId}/${kind}`, {
      method: "POST",
      // Search term reports only take the org's time zone, and are split by storefront.
      body: {
        startTime: from,
        endTime: to,
        timeZone: kind === "searchterms" ? "ORTZ" : "UTC",
        ...(kind === "searchterms" ? { groupBy: ["countryOrRegion"] } : {}),
        returnRecordsWithNoMetrics: false,
        returnRowTotals: true,
        returnGrandTotals: false,
        selector: { orderBy: [{ field: "impressions", sortOrder: "DESCENDING" }], pagination: { offset: 0, limit: 1000 } },
      },
    });
    return data?.reportingDataResponse?.row ?? [];
  }
}

export interface Campaign {
  id: number;
  name: string;
  adamId: number;
  status?: string;
  displayStatus?: string;
  countriesOrRegions?: string[];
  /** Where the ads show: only APPSTORE_SEARCH_RESULTS campaigns have keywords and search terms. */
  supplySources?: string[];
  adChannelType?: string;
}

interface Metrics {
  impressions?: number;
  taps?: number;
  totalInstalls?: number;
  installs?: number;
  tapInstalls?: number;
  localSpend?: { amount: string; currency: string };
}
export interface CampaignReportRow {
  metadata: { campaignId: number; campaignName?: string; adamId?: number };
  granularity?: Array<Metrics & { date: string }>;
}
export interface TotalsRow {
  metadata: { keyword?: string; searchTermText?: string | null; matchType?: string; countryOrRegion?: string; countriesOrRegions?: string[]; keywordStatus?: string };
  total?: Metrics;
}

const installsOf = (m: Metrics | undefined) => m?.totalInstalls ?? m?.installs ?? m?.tapInstalls ?? 0;
const spendOf = (m: Metrics | undefined) => Number(m?.localSpend?.amount ?? 0);
const r2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: Date) => d.toISOString().slice(0, 10);
const cell = (v: string | number) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));

export interface SearchAdsPullResult {
  orgId: string;
  campaigns: Array<{ id: number; name: string; status?: string }>;
  currency?: string;
  last30: { spend: number; installs: number; taps: number; impressions: number };
  keywords: number;
  searchTerms: number;
  /** Reports that could not be read; the rest were written. */
  errors: string[];
  files: string[];
}

/** The App Store app's campaigns only: ads for other apps in the same organization stay out. */
export async function pullSearchAds(project: Project, client: SearchAdsClient, now = new Date(), days = 30): Promise<SearchAdsPullResult> {
  const adamId = project.spec.stores.appStore?.appId;
  if (!adamId || !/^\d+$/.test(adamId)) throw new Error("Set stores.appStore.appId (the numeric App Store id) first: campaigns are matched to the app by it.");
  const orgId = await client.org();
  const only = project.spec.stores.appStore?.searchAds?.campaigns;
  const campaigns = (await client.campaigns()).filter((c) => String(c.adamId) === adamId && (!only || only.includes(String(c.id))));
  const to = day(new Date(now.getTime() - 86_400_000));
  const from = day(new Date(now.getTime() - days * 86_400_000));
  const dir = searchAdsDir(project.root);
  await mkdir(dir, { recursive: true });

  const ids = new Set(campaigns.map((c) => c.id));
  const rows = campaigns.length ? (await client.daily(from, to)).filter((r) => ids.has(r.metadata.campaignId)) : [];
  let currency: string | undefined;
  const byDay = new Map<string, { spend: number; installs: number; taps: number; impressions: number }>();
  for (const r of rows) {
    for (const g of r.granularity ?? []) {
      currency ??= g.localSpend?.currency;
      const d = byDay.get(g.date) ?? { spend: 0, installs: 0, taps: 0, impressions: 0 };
      d.spend += spendOf(g);
      d.installs += installsOf(g);
      d.taps += g.taps ?? 0;
      d.impressions += g.impressions ?? 0;
      byDay.set(g.date, d);
    }
  }
  // Keep earlier days from previous pulls; this pull's days replace theirs.
  const dailyFile = join(dir, "daily.csv");
  const kept = new Map<string, string>();
  if (existsSync(dailyFile)) for (const l of (await readFile(dailyFile, "utf8")).split("\n").slice(1).filter(Boolean)) kept.set(l.split(",")[0]!, l);
  for (const [date, d] of byDay) kept.set(date, [date, r2(d.spend), d.installs, d.taps, d.impressions, d.installs ? r2(d.spend / d.installs) : ""].join(","));
  await writeFile(dailyFile, `date,spend,installs,taps,impressions,cpi\n${[...kept.keys()].sort().map((k) => kept.get(k)).join("\n")}${kept.size ? "\n" : ""}`);

  type Agg = { text: string; match?: string; campaign: string; impressions: number; taps: number; installs: number; spend: number };
  const keywords: Agg[] = [];
  const terms: Agg[] = [];
  const errors: string[] = [];
  const hasKeywords = (c: Campaign) => !c.supplySources || c.supplySources.includes("APPSTORE_SEARCH_RESULTS");
  for (const c of campaigns.filter(hasKeywords)) {
    const soft = async (kind: "keywords" | "searchterms") => {
      try {
        return await client.totals(c.id, kind, from, to);
      } catch (e) {
        errors.push(`${c.name} ${kind === "keywords" ? "keywords" : "search terms"}: ${(e as Error).message}`);
        return [];
      }
    };
    for (const r of await soft("keywords")) {
      if (!r.metadata.keyword) continue;
      keywords.push({ text: r.metadata.keyword, match: r.metadata.matchType, campaign: c.name, impressions: r.total?.impressions ?? 0, taps: r.total?.taps ?? 0, installs: installsOf(r.total), spend: spendOf(r.total) });
    }
    for (const r of await soft("searchterms")) {
      const text = r.metadata.searchTermText;
      if (!text) continue;
      terms.push({ text, campaign: c.name, impressions: r.total?.impressions ?? 0, taps: r.total?.taps ?? 0, installs: installsOf(r.total), spend: spendOf(r.total) });
    }
  }
  const sortAgg = (a: Agg, b: Agg) => b.installs - a.installs || b.taps - a.taps || b.impressions - a.impressions;
  keywords.sort(sortAgg);
  terms.sort(sortAgg);
  const table = (head: string, list: Agg[], match: boolean) =>
    `${head}${match ? ",match" : ""},campaign,impressions,taps,installs,spend,cpi\n${list.map((k) => [cell(k.text), ...(match ? [k.match ?? ""] : []), cell(k.campaign), k.impressions, k.taps, k.installs, r2(k.spend), k.installs ? r2(k.spend / k.installs) : ""].join(",")).join("\n")}${list.length ? "\n" : ""}`;
  await writeFile(join(dir, "keywords.csv"), table("keyword", keywords, true));
  await writeFile(join(dir, "search-terms.csv"), table("search_term", terms, false));

  const total = [...byDay.values()].reduce((a, d) => ({ spend: a.spend + d.spend, installs: a.installs + d.installs, taps: a.taps + d.taps, impressions: a.impressions + d.impressions }), { spend: 0, installs: 0, taps: 0, impressions: 0 });
  const targets = new Set(Object.values(project.spec.targets).flat().map((t) => t.toLowerCase()));
  const newTerms = terms.filter((t) => t.installs > 0 && !targets.has(t.text.toLowerCase())).slice(0, 15);
  const wasted = keywords.filter((k) => k.spend > 0 && k.installs === 0).sort((a, b) => b.spend - a.spend).slice(0, 10);
  const money = (n: number) => `${r2(n)}${currency ? ` ${currency}` : ""}`;
  const md = [
    "# Apple Search Ads",
    "",
    `Written by \`search-ads pull\` from your own API key, ${from} to ${to}.`,
    "",
    campaigns.length ? `Campaigns for this app: ${campaigns.map((c) => `${c.name} (${c.displayStatus ?? c.status ?? "?"})`).join(", ")}.` : "No campaign for this app in the organization.",
    "",
    `- Spend: ${money(total.spend)}`,
    `- Installs: ${total.installs}${total.installs ? ` (${money(total.spend / total.installs)} each)` : ""}`,
    `- Taps: ${total.taps} of ${total.impressions} impressions`,
    "",
    "## Search terms that brought installs and are not targets",
    "",
    "People typed these and installed. Each one is a candidate for targets in appeeky.spec.yaml and for the keyword field: ranking for it organically is free.",
    "",
    "| search term | installs | taps | spend |",
    "| --- | --- | --- | --- |",
    ...(newTerms.length ? newTerms.map((t) => `| ${t.text.replace(/\|/g, "\\|")} | ${t.installs} | ${t.taps} | ${money(t.spend)} |`) : ["| none in this window | | | |"]),
    "",
    "## Keywords that spent and brought no install",
    "",
    "| keyword | match | spend | taps |",
    "| --- | --- | --- | --- |",
    ...(wasted.length ? wasted.map((k) => `| ${k.text.replace(/\|/g, "\\|")} | ${k.match ?? ""} | ${money(k.spend)} | ${k.taps} |`) : ["| none in this window | | | |"]),
    "",
  ].join("\n");
  await writeFile(join(dir, "summary.md"), md);

  return {
    orgId,
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.displayStatus ?? c.status })),
    currency,
    last30: { spend: r2(total.spend), installs: total.installs, taps: total.taps, impressions: total.impressions },
    keywords: keywords.length,
    searchTerms: terms.length,
    errors,
    files: ["daily.csv", "keywords.csv", "search-terms.csv", "summary.md"].map((f) => join(dir, f)),
  };
}

/** `ad_installs` and `cpa` per day from appeeky/search-ads/daily.csv, for the App Store app. */
export function searchAdsMetricSource(root: string): MetricSource | null {
  const file = join(searchAdsDir(root), "daily.csv");
  if (!existsSync(file)) return null;
  let rows: Promise<Array<{ date: string; spend: number; installs: number }>> | undefined;
  return {
    label: "Apple Search Ads in the repo",
    async window(store, _appId, from, to) {
      if (store !== "app-store") return null;
      rows ??= readFile(file, "utf8").then((t) =>
        t
          .split("\n")
          .slice(1)
          .filter(Boolean)
          .map((l) => {
            const [date, spend, installs] = l.split(",");
            return { date: date!, spend: Number(spend), installs: Number(installs) };
          }),
      );
      const inside = (await rows).filter((r) => r.date >= from && r.date < to);
      if (inside.length === 0) return null;
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
      const spend = inside.reduce((n, r) => n + r.spend, 0);
      const installs = inside.reduce((n, r) => n + r.installs, 0);
      const values: MetricWindow["values"] = { ad_installs: installs / days, ...(installs > 0 ? { cpa: spend / installs } : {}) };
      return { from, to, days, values };
    },
  };
}
