import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { appeekyMetricSource, metaMetricSource, tiktokMetricSource, type AppeekyApi } from "./appeeky-api.js";
import { SPEC_DIR } from "./files.js";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { SpecFile, StoreId } from "./schema.js";

/**
 * Paid channels for one app over a date range: Apple Search Ads from the app's
 * connection in Appeeky, Meta and TikTok from the campaigns listed in
 * `ads:` in appeeky.spec.yaml. `appeeky-spec ads --save` writes it to
 * `appeeky/ads/<date>.yaml`, so the repo keeps a history next to the listing.
 */

export type AdsChannelId = "apple-search-ads" | "meta" | "tiktok";

export interface AdsChannel {
  channel: AdsChannelId;
  spendPerDay?: number;
  /** Installs for Apple Search Ads and Meta; optimization-event conversions for TikTok. */
  resultsPerDay?: number;
  costPerResult?: number;
  result: "installs" | "conversions";
}

export interface AdsSnapshot {
  from: string;
  /** Exclusive end. */
  to: string;
  days: number;
  currency?: string;
  channels: AdsChannel[];
  /** Channels that could not be read, with the reason. */
  errors: Array<{ channel: AdsChannelId; message: string }>;
}

const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);

function channelFrom(id: AdsChannelId, w: MetricWindow): AdsChannel | null {
  const v = w.values;
  if (id === "apple-search-ads") {
    if (v.ad_installs === undefined) return null;
    const spend = v.cpa !== undefined ? v.cpa * v.ad_installs : undefined;
    return { channel: id, spendPerDay: round(spend), resultsPerDay: round(v.ad_installs), costPerResult: round(v.cpa), result: "installs" };
  }
  if (id === "meta") {
    if (v.meta_spend === undefined) return null;
    return { channel: id, spendPerDay: round(v.meta_spend), resultsPerDay: round(v.meta_installs), costPerResult: round(v.meta_cpi), result: "installs" };
  }
  if (v.tiktok_spend === undefined) return null;
  return { channel: id, spendPerDay: round(v.tiktok_spend), resultsPerDay: round(v.tiktok_conversions), costPerResult: round(v.tiktok_cpa), result: "conversions" };
}

/** Every paid channel this spec can read, over the `days` up to `now` (today left out: it is not over yet). */
export async function adsSnapshot(
  api: AppeekyApi | null,
  spec: SpecFile,
  app: { store: StoreId; appId: string } | null,
  days: number,
  now = new Date(),
  /** Apple Search Ads pulled with your own key (appeeky/search-ads/); used instead of Appeeky's. */
  ownSearchAds: MetricSource | null = null,
): Promise<AdsSnapshot> {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(to) - Math.max(1, days) * 86_400_000).toISOString().slice(0, 10);
  const sources: Array<[AdsChannelId, MetricSource]> = [];
  if (app && ownSearchAds) sources.push(["apple-search-ads", ownSearchAds]);
  else if (app && api) sources.push(["apple-search-ads", appeekyMetricSource(api)]);
  if (api && spec.ads.meta) sources.push(["meta", metaMetricSource(api, spec.ads.meta)]);
  if (api && spec.ads.tiktok) sources.push(["tiktok", tiktokMetricSource(api, spec.ads.tiktok)]);

  const snapshot: AdsSnapshot = { from, to, days: Math.max(1, days), channels: [], errors: [] };
  for (const [id, source] of sources) {
    try {
      const w = await source.window(app?.store ?? "app-store", app?.appId ?? "", from, to);
      const channel = w ? channelFrom(id, w) : null;
      if (channel) snapshot.channels.push(channel);
      if (w?.currency && !snapshot.currency) snapshot.currency = w.currency;
    } catch (e) {
      snapshot.errors.push({ channel: id, message: (e as Error).message });
    }
  }
  return snapshot;
}

export function adsDir(root: string): string {
  return join(root, SPEC_DIR, "ads");
}

/** Write a snapshot to `appeeky/ads/<to>.yaml` and return the path. */
export async function saveAdsSnapshot(root: string, snapshot: AdsSnapshot): Promise<string> {
  await mkdir(adsDir(root), { recursive: true });
  const file = join(adsDir(root), `${snapshot.to}.yaml`);
  const { errors: _errors, ...kept } = snapshot;
  await writeFile(file, YAML.stringify(kept, { lineWidth: 0 }));
  return file;
}

export const CHANNEL_LABELS: Record<AdsChannelId, string> = {
  "apple-search-ads": "Apple Search Ads",
  meta: "Meta",
  tiktok: "TikTok",
};
