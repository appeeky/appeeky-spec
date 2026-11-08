import type { AppeekyApi } from "./appeeky-api.js";
import type { MetricSource } from "./metrics.js";
import type { SpecFile, StoreId } from "./schema.js";

/**
 * Install attribution from Appeeky Analytics: which source each install came from
 * (organic store search, Apple Search Ads down to the keyword, a smart link, the
 * Google Play referrer) and the trials and revenue it led to.
 *
 * Two ways to reach it, like the stores:
 *   via: self    your own server on Cloudflare (apps/worker), with ATTRIBUTION_TOKEN (its ADMIN_TOKEN)
 *   via: hosted  Appeeky's hosted service, through the Appeeky API with APPEEKY_API_KEY
 */

export type AttributionConfig = NonNullable<SpecFile["attribution"]>;

type Fetcher = typeof fetch;

export interface AttributionClient {
  readonly label: string;
  get<T>(view: string, query?: Record<string, string>): Promise<T>;
  post<T>(view: string, body: unknown): Promise<T>;
}

export interface SourceRow {
  source: string;
  campaign: string | null;
  installs: number;
  trials: number;
  payers: number;
  revenueUsd: number;
}

export interface Summary {
  days: number;
  since: string;
  installs: number;
  revenueUsd: number;
  bySource: SourceRow[];
  unattributedRevenueUsd: number;
}

export interface BreakdownRow {
  key: string | null;
  count: number;
  revenueUsd: number | null;
  payers: number;
  campaign?: string | null;
  country?: string | null;
}

export interface LinkStats {
  link: { id: string; slug: string; name: string; campaign: string; channel: string | null };
  clicks: { total: number; ios: number; android: number; other: number };
  installs: number;
  revenueUsd: number;
}

/** Both the self-hosted server (plain JSON) and the Appeeky API (`{ data }`) answer here. */
const unwrap = <T>(body: unknown): T => (body && typeof body === "object" && "data" in body ? (body as { data: T }).data : (body as T));

export function selfHostedClient(config: AttributionConfig, token: string, fetcher: Fetcher = fetch, app = appIdsOf(config)[0]!): AttributionClient {
  if (!config.url) throw new Error("attribution.url is needed with via: self (your Appeeky Analytics server).");
  const base = `${config.url.replace(/\/$/, "")}/v1/apps/${encodeURIComponent(app)}`;
  const call = async <T>(view: string, init: RequestInit, query: Record<string, string> = {}): Promise<T> => {
    const url = new URL(`${base}/${view}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetcher(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new Error(`Attribution ${view}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    return unwrap<T>(body);
  };
  return {
    label: "Appeeky Analytics (self-hosted)",
    get: (view, query) => call(view, { method: "GET" }, query),
    post: (view, body) => call(view, { method: "POST", body: JSON.stringify(body) }),
  };
}

export function hostedClient(config: AttributionConfig, api: AppeekyApi, app = appIdsOf(config)[0]!): AttributionClient {
  const base = `/analytics/apps/${encodeURIComponent(app)}`;
  return {
    label: "Appeeky Analytics",
    get: async (view, query) => unwrap(await api.get(`${base}/${view}`, query)),
    post: async (view, body) => unwrap(await api.post(`${base}/${view}`, body)),
  };
}

function appIdsOf(config: AttributionConfig): string[] {
  return typeof config.app === "string" ? [config.app] : [config.app["app-store"], config.app["google-play"]].filter((x): x is string => Boolean(x));
}

/** The Appeeky Analytics app for each store: one id for every store in the spec, or one per store. */
export function attributionApps(spec: SpecFile): Partial<Record<StoreId, string>> {
  const config = spec.attribution;
  if (!config) return {};
  if (typeof config.app !== "string") return { ...config.app };
  const out: Partial<Record<StoreId, string>> = {};
  if (spec.stores.appStore) out["app-store"] = config.app;
  if (spec.stores.googlePlay) out["google-play"] = config.app;
  if (!out["app-store"] && !out["google-play"]) out["app-store"] = config.app;
  return out;
}

export type AttributionClients = Partial<Record<StoreId, AttributionClient>>;

/** A client per store the spec's `attribution:` covers, or why there are none. */
export function attributionClients(spec: SpecFile, api: AppeekyApi | undefined, env: NodeJS.ProcessEnv = process.env): AttributionClients | { missing: string } {
  const config = spec.attribution;
  if (!config) return { missing: "No attribution: in appeeky.spec.yaml." };
  if (config.via === "self" && !env.ATTRIBUTION_TOKEN) return { missing: "Set ATTRIBUTION_TOKEN to your Appeeky Analytics server's ADMIN_TOKEN." };
  if (config.via !== "self" && !api) return { missing: "Set APPEEKY_API_KEY to read attribution from Appeeky." };
  const made = new Map<string, AttributionClient>();
  const out: AttributionClients = {};
  for (const [store, app] of Object.entries(attributionApps(spec)) as [StoreId, string][]) {
    // One app id shared by both stores is one client.
    if (!made.has(app)) made.set(app, config.via === "self" ? selfHostedClient(config, env.ATTRIBUTION_TOKEN!, fetch, app) : hostedClient(config, api!, app));
    out[store] = made.get(app)!;
  }
  return out;
}

/**
 * The client for one store, or the first one. Without a store, Google Play comes first:
 * its install referrer is what lets a smart link count installs.
 */
export function attributionClient(spec: SpecFile, api: AppeekyApi | undefined, env: NodeJS.ProcessEnv = process.env, store?: StoreId): AttributionClient | { missing: string } {
  const clients = attributionClients(spec, api, env);
  if ("missing" in clients) return clients as { missing: string };
  const client = store ? clients[store] : (clients["google-play"] ?? clients["app-store"]);
  return client ?? { missing: `No attribution app for ${store} in appeeky.spec.yaml.` };
}

/** Which store the client `attributionClient` picks without one belongs to. */
export function linkStore(spec: SpecFile): StoreId | undefined {
  const apps = attributionApps(spec);
  return apps["google-play"] ? "google-play" : apps["app-store"] ? "app-store" : undefined;
}

export const isClient = (c: AttributionClient | { missing: string }): c is AttributionClient => !("missing" in c);
export const hasClients = (c: AttributionClients | { missing: string }): c is AttributionClients => !("missing" in c);

/** Installs from organic store search (App Store or Google Play), the ones a listing change moves. */
export function organicRow(summary: Summary): { installs: number; payers: number; revenueUsd: number } {
  const rows = summary.bySource.filter((r) => r.source === "organic");
  return {
    installs: rows.reduce((n, r) => n + r.installs, 0),
    payers: rows.reduce((n, r) => n + r.payers, 0),
    revenueUsd: rows.reduce((n, r) => n + r.revenueUsd, 0),
  };
}

const DAY = 86_400_000;

/**
 * Organic installs and what they paid, around a push. The server answers for the
 * installs first seen in the last N days, so a window that ends before today is the
 * difference of two answers. Revenue counts what those installs paid up to now, so
 * an older window has had longer to pay: a rise in organic revenue after a push is
 * a conservative reading.
 */
export function attributionMetricSource(clients: AttributionClient | AttributionClients, now = new Date()): MetricSource {
  const daysBack = (iso: string) => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / DAY));
  const forStore = (store: StoreId): AttributionClient | undefined => ("get" in clients ? (clients as AttributionClient) : (clients as AttributionClients)[store]);
  const any = "get" in clients ? (clients as AttributionClient) : Object.values(clients as AttributionClients)[0];
  return {
    label: any?.label ?? "Appeeky Analytics",
    async window(store, _appId, from, to) {
      const client = forStore(store);
      if (!client) return null;
      const summary = (days: number) => client.get<Summary>("summary", { days: String(days) });
      const fromBack = daysBack(from);
      const toBack = daysBack(to);
      if (fromBack <= toBack || fromBack > 180) return null;
      const all = organicRow(await summary(fromBack));
      const later = toBack > 0 ? organicRow(await summary(toBack)) : { installs: 0, payers: 0, revenueUsd: 0 };
      const days = fromBack - toBack;
      const installs = all.installs - later.installs;
      if (installs <= 0) return null;
      return {
        from,
        to,
        days,
        values: {
          organic_installs: installs / days,
          organic_revenue: (all.revenueUsd - later.revenueUsd) / days,
          organic_paid: (all.payers - later.payers) / installs,
        },
        currency: "USD",
      };
    },
  };
}

/** A smart link for an experiment: one URL that sends each visitor to the right store, counted to the install. */
export async function createExperimentLink(
  client: AttributionClient,
  experimentId: string,
  stores: { appStoreId?: string; packageName?: string },
  channel?: string,
): Promise<{ slug: string; id: string }> {
  return client.post<{ slug: string; id: string }>("links", {
    name: experimentId,
    campaign: experimentId,
    ...(stores.appStoreId ? { iosUrl: `https://apps.apple.com/app/id${stores.appStoreId}` } : {}),
    ...(stores.packageName ? { androidUrl: `https://play.google.com/store/apps/details?id=${stores.packageName}` } : {}),
    ...(channel ? { channel } : {}),
  });
}

/** Clicks, installs and revenue of one smart link over the last 30 days. */
export const LINK_METRICS = ["link_clicks", "link_installs", "link_revenue"] as const;

/** Reads a link experiment's value: clicks, or the installs and revenue counted to its link. */
export type LinkValue = (e: { metric: string; link?: { slug: string; store?: StoreId } }) => Promise<number | undefined>;

export function linkValueReader(spec: SpecFile, api: AppeekyApi | undefined, env: NodeJS.ProcessEnv = process.env): LinkValue {
  return async (e) => {
    if (!e.link || !(LINK_METRICS as readonly string[]).includes(e.metric)) return undefined;
    const client = attributionClient(spec, api, env, e.link.store);
    const stats = isClient(client) ? await linkResult(client, e.link.slug).catch(() => null) : null;
    if (!stats) return undefined;
    return e.metric === "link_clicks" ? stats.clicks.total : e.metric === "link_installs" ? stats.installs : stats.revenueUsd;
  };
}

export async function linkResult(client: AttributionClient, slug: string): Promise<LinkStats | null> {
  const data = await client.get<{ links?: LinkStats[] }>("links", { range: "30d" });
  return data?.links?.find((l) => l.link.slug === slug) ?? null;
}

/**
 * On iOS the App Store passes nothing from a link click to the installed app, and the
 * service does not fingerprint devices, so a new iOS install is never tied to a click.
 * The SDK reads the link only on the app's first launch, so on iOS a link install is
 * counted only when that first launch comes through the link (a deep link opening an
 * app that was installed but never opened). Link installs are, in practice, Google
 * Play installs (the install referrer). For an App Store only app, measure clicks, or
 * organic installs around the post.
 */
export const IOS_LINK_NOTE =
  "  iOS: the App Store does not pass a link to a new install, so link installs and revenue are, in practice, Google Play\n" +
  "  installs. For this App Store only app use --metric link_clicks (or organic_installs).";

/** An installs or revenue metric on a link that can only send people to the App Store. */
export function iosOnlyLink(spec: SpecFile, metric: string): boolean {
  const ios = spec.attribution ? linkStore(spec) === "app-store" : Boolean(spec.stores.appStore && !spec.stores.googlePlay);
  return ios && (metric === "link_installs" || metric === "link_revenue");
}
