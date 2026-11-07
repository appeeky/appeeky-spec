import type { AppeekyApi } from "./appeeky-api.js";
import type { SpecFile, StoreId } from "./schema.js";

/**
 * `attribution init`: create (or find) the app in Appeeky Analytics for each store in the
 * spec, and say what to put in the app and in RevenueCat. Self-hosted, it talks to your
 * server with its admin token; hosted, it turns attribution on for the app in Appeeky.
 */

export interface AttributionApp {
  store: StoreId;
  /** The id the spec reads: the server's app id, or the store id when hosted. */
  id: string;
  publishableKey: string;
  /** The SDK's ingest URL. */
  endpoint: string;
  created: boolean;
}

interface ServerApp {
  id: string;
  name: string;
  platform: "apple" | "google";
  storeAppId?: string | null;
  publishableKey: string;
}

const PLATFORM: Record<StoreId, "apple" | "google"> = { "app-store": "apple", "google-play": "google" };

export function specStores(spec: SpecFile): Array<{ store: StoreId; storeId: string }> {
  return [
    ...(spec.stores.appStore?.appId ? [{ store: "app-store" as const, storeId: spec.stores.appStore.appId }] : []),
    ...(spec.stores.googlePlay?.packageName ? [{ store: "google-play" as const, storeId: spec.stores.googlePlay.packageName }] : []),
  ];
}

/** Self-hosted: find each store's app on the server by its store id, or create it. */
export async function initSelfHosted(spec: SpecFile, url: string, token: string, fetcher: typeof fetch = fetch): Promise<AttributionApp[]> {
  const base = url.replace(/\/$/, "");
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetcher(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const body = (await res.json().catch(() => null)) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`${path}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    return body;
  };
  const { apps } = await call<{ apps: ServerApp[] }>("/v1/apps");
  const out: AttributionApp[] = [];
  for (const { store, storeId } of specStores(spec)) {
    const found = apps.find((a) => a.platform === PLATFORM[store] && a.storeAppId === storeId);
    const app =
      found ??
      (await call<ServerApp>("/v1/apps", {
        method: "POST",
        body: JSON.stringify({ name: spec.app.name, platform: PLATFORM[store], storeAppId: storeId }),
      }));
    out.push({ store, id: app.id, publishableKey: app.publishableKey, endpoint: `${base}/v1/ingest`, created: !found });
  }
  return out;
}

/** Hosted: turn attribution on for each store's app in Appeeky (already on is fine). */
export async function initHosted(spec: SpecFile, api: AppeekyApi): Promise<AttributionApp[]> {
  const out: AttributionApp[] = [];
  for (const { store, storeId } of specStores(spec)) {
    const res = await api.post<{ publishableKey: string; endpoint: string; enabledAt?: string } | { data: { publishableKey: string; endpoint: string } }>(
      `/analytics/apps/${encodeURIComponent(storeId)}/enable`,
      {},
    );
    const body = res && "data" in res ? res.data : res;
    out.push({ store, id: storeId, publishableKey: body.publishableKey, endpoint: body.endpoint, created: true });
  }
  return out;
}

/** The `attribution:` block for these apps: one id, or one per store when they differ. */
export function attributionBlock(via: "self" | "hosted", apps: AttributionApp[], url?: string): NonNullable<SpecFile["attribution"]> {
  const ids = [...new Set(apps.map((a) => a.id))];
  const app = ids.length === 1 ? ids[0]! : Object.fromEntries(apps.map((a) => [a.store, a.id]));
  return { via, ...(via === "self" && url ? { url: url.replace(/\/$/, "") } : {}), app } as NonNullable<SpecFile["attribution"]>;
}

/** What to do next, in the app and in RevenueCat. */
export function nextSteps(via: "self" | "hosted", apps: AttributionApp[], url?: string): string[] {
  const lines: string[] = ["In the app (React Native and Expo; Swift, Kotlin and Flutter work the same way):", ""];
  const endpoint = via === "self" && apps[0] ? `, endpoint: "${apps[0].endpoint}"` : "";
  const ios = apps.find((a) => a.store === "app-store");
  const android = apps.find((a) => a.store === "google-play");
  // One codebase, a key per platform.
  const key = ios && android ? `Platform.OS === "ios" ? "${ios.publishableKey}" : "${android.publishableKey}"` : `"${(ios ?? android)!.publishableKey}"`;
  lines.push(`  Appeeky.init({ key: ${key}${endpoint} });`);
  lines.push("  Appeeky.identify(await Purchases.getAppUserID());", "");
  if (via === "self") {
    lines.push(
      "In RevenueCat, Integrations → Webhooks:",
      `  URL: ${url!.replace(/\/$/, "")}/v1/webhooks/revenuecat`,
      "  Authorization header: your REVENUECAT_WEBHOOK_SECRET",
      "  Environment: production",
    );
  } else {
    lines.push("Connect RevenueCat in Appeeky if it is not connected: purchases reach attribution from there.");
  }
  return lines;
}
