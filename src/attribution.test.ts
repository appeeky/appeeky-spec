import { describe, expect, it } from "vitest";
import { AppeekyApi } from "./appeeky-api.js";
import { attributionApps, attributionClient, attributionClients, attributionMetricSource, createExperimentLink, hostedClient, iosOnlyLink, isClient, linkResult, organicRow, selfHostedClient, type Summary } from "./attribution.js";
import { pullData } from "./data.js";
import { closeExperiment, experimentSchema } from "./experiments.js";
import { specFileSchema, type Project } from "./schema.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const summary = (installs: number, revenue: number, days: number): Summary => ({
  days,
  since: "2026-10-01",
  installs,
  revenueUsd: revenue,
  unattributedRevenueUsd: 0,
  bySource: [
    { source: "organic", campaign: null, installs, trials: 1, payers: Math.round(installs / 10), revenueUsd: revenue },
    { source: "apple_search_ads", campaign: "542", installs: 5, trials: 0, payers: 1, revenueUsd: 9 },
  ],
});

/** A fake Appeeky Analytics server: answers by view, records requests. */
function fakeServer(views: Record<string, (q: URLSearchParams, body?: unknown) => unknown>, wrap = false) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const view = Object.keys(views).find((v) => url.pathname.endsWith(`/${v}`));
    if (!view) return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 404 });
    const out = views[view]!(url.searchParams, init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(wrap ? { data: out } : out), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("attribution clients", () => {
  it("reads a self-hosted server with its admin token", async () => {
    const { fetcher, calls } = fakeServer({ summary: () => summary(40, 120, 30) });
    const client = selfHostedClient({ via: "self", url: "https://a.example.dev/", app: "app_1" }, "secret", fetcher);
    const s = await client.get<Summary>("summary", { days: "30" });
    expect(organicRow(s)).toEqual({ installs: 40, payers: 4, revenueUsd: 120 });
    expect(calls[0]!.url.href).toBe("https://a.example.dev/v1/apps/app_1/summary?days=30");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("reads Appeeky's hosted service through the API", async () => {
    const { fetcher, calls } = fakeServer({ summary: () => summary(10, 5, 7) }, true);
    const client = hostedClient({ via: "hosted", app: "123" }, new AppeekyApi("key", { baseUrl: "https://api.test/v1", fetcher }));
    expect((await client.get<Summary>("summary", { days: "7" })).installs).toBe(10);
    expect(calls[0]!.url.pathname).toBe("/v1/analytics/apps/123/summary");
  });

  it("says what is missing", () => {
    const spec = (attribution: unknown) => specFileSchema.parse({ version: 1, app: { name: "S" }, attribution });
    expect(attributionClient(spec(undefined), undefined)).toEqual({ missing: "No attribution: in appeeky.spec.yaml." });
    expect(isClient(attributionClient(spec({ via: "self", url: "https://a.dev", app: "x" }), undefined, {}))).toBe(false);
    expect(isClient(attributionClient(spec({ via: "self", url: "https://a.dev", app: "x" }), undefined, { ATTRIBUTION_TOKEN: "t" }))).toBe(true);
    expect(() => spec({ via: "self", app: "x" })).toThrow();
  });
});

describe("organic installs around a push", () => {
  it("takes the difference of two answers for a window that ended before today", async () => {
    const now = new Date("2026-11-15T00:00:00Z");
    const { fetcher, calls } = fakeServer({ summary: (q) => (q.get("days") === "14" ? summary(70, 210, 14) : summary(30, 90, 7)) });
    const source = attributionMetricSource(selfHostedClient({ via: "self", url: "https://a.dev", app: "x" }, "t", fetcher), now);
    const w = await source.window("app-store", "1", "2026-11-01", "2026-11-08");
    expect(calls.map((c) => c.url.searchParams.get("days"))).toEqual(["14", "7"]);
    expect(w?.values).toEqual({ organic_installs: 40 / 7, organic_revenue: 120 / 7, organic_paid: (7 - 3) / 40 });
  });
});

describe("experiment links", () => {
  it("creates a smart link to both stores and reads its result", async () => {
    const { fetcher, calls } = fakeServer({
      links: (_q, body) => (body ? { id: "l1", slug: "ab12" } : { links: [{ link: { id: "l1", slug: "ab12", name: "x", campaign: "x", channel: "tiktok" }, clicks: { total: 90, ios: 50, android: 40, other: 0 }, installs: 12, revenueUsd: 33 }] }),
    });
    const client = selfHostedClient({ via: "self", url: "https://a.dev", app: "x" }, "t", fetcher);
    expect(await createExperimentLink(client, "2026-11-04-hook", { appStoreId: "123", packageName: "com.x" }, "tiktok")).toEqual({ id: "l1", slug: "ab12" });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ name: "2026-11-04-hook", campaign: "2026-11-04-hook", iosUrl: "https://apps.apple.com/app/id123", androidUrl: "https://play.google.com/store/apps/details?id=com.x", channel: "tiktok" });
    expect((await linkResult(client, "ab12"))?.installs).toBe(12);
  });

  it("keeps the link on the experiment and judges it against its target", () => {
    const e = experimentSchema.parse({ id: "x", type: "ugc", hypothesis: "h", metric: "link_installs", baseline: 0, target: 10, startedAt: "2026-11-01T00:00:00Z", link: { slug: "ab12", url: "https://a.dev/l/ab12" } });
    expect(closeExperiment(e, 12, undefined).status).toBe("won");
  });
});

describe("data pull with attribution only", () => {
  it("writes sources, keywords, campaigns, countries and links without an Appeeky key", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-attr-"));
    const spec = specFileSchema.parse({ version: 1, app: { name: "S" }, stores: { appStore: { appId: "123" } }, attribution: { via: "self", url: "https://a.dev", app: "x" } });
    const { fetcher } = fakeServer({
      summary: () => summary(40, 120, 30),
      breakdown: (q) =>
        q.get("dim") === "keyword"
          ? [{ key: "87675432", count: 8, payers: 2, revenueUsd: 14 }]
          : q.get("dim") === "campaign"
            ? { rows: [{ key: null, count: 20, payers: 2, revenueUsd: 10 }, { key: "542", count: 8, payers: 2, revenueUsd: 14 }] }
            : [{ key: "US", count: 8, payers: 2, revenueUsd: 14 }],
      links: () => ({ links: [{ link: { id: "l1", slug: "ab12", name: "hook", campaign: "hook", channel: "tiktok" }, clicks: { total: 9, ios: 5, android: 4, other: 0 }, installs: 3, revenueUsd: 4 }] }),
    });
    const client = selfHostedClient(spec.attribution!, "t", fetcher);
    const result = await pullData(undefined, { root, spec, listings: { "app-store": {}, "google-play": {} } } as Project, 30, new Date("2026-11-04T00:00:00Z"), client);
    expect(result.errors).toEqual([]);
    expect(result.files.map((f) => f.name).sort()).toEqual(["attribution-campaigns", "attribution-countries", "attribution-keywords", "attribution-sources", "smart-links"]);
    expect(readFileSync(join(root, ".appeeky", "data", "attribution-keywords.csv"), "utf8")).toBe("keywordId,installs,payers,revenueUsd\n87675432,8,2,14\n");
    expect(readFileSync(join(root, ".appeeky", "data", "attribution-campaigns.csv"), "utf8")).toBe("campaign,installs,payers,revenueUsd\n(none),20,2,10\n542,8,2,14\n");
  });
});

describe("links on iOS", () => {
  const spec = (stores: object) => specFileSchema.parse({ version: 1, app: { name: "x" }, stores });
  it("warns when installs are measured on an App Store only link", () => {
    expect(iosOnlyLink(spec({ appStore: { appId: "1" } }), "link_installs")).toBe(true);
    expect(iosOnlyLink(spec({ appStore: { appId: "1" } }), "link_clicks")).toBe(false);
    expect(iosOnlyLink(spec({ appStore: { appId: "1" }, googlePlay: { packageName: "com.x" } }), "link_installs")).toBe(false);
  });
});

describe("an app per store", () => {
  const spec = (app: unknown) =>
    specFileSchema.parse({ version: 1, app: { name: "x" }, stores: { appStore: { appId: "1" }, googlePlay: { packageName: "com.x" } }, attribution: { via: "self", url: "https://a.dev", app } });
  const env = { ATTRIBUTION_TOKEN: "t" } as NodeJS.ProcessEnv;
  it("shares one id across the stores, or takes one per store", () => {
    expect(attributionApps(spec("app_1"))).toEqual({ "app-store": "app_1", "google-play": "app_1" });
    expect(attributionApps(spec({ "app-store": "app_ios", "google-play": "app_and" }))).toEqual({ "app-store": "app_ios", "google-play": "app_and" });
  });
  it("measures each release with its own store's app", async () => {
    const seen: string[] = [];
    const fetcher = (async (url: URL) => {
      seen.push(url.pathname);
      return new Response(JSON.stringify({ days: 1, since: "", installs: 10, revenueUsd: 0, unattributedRevenueUsd: 0, bySource: [{ source: "organic", campaign: null, installs: 10, trials: 0, payers: 1, revenueUsd: 5 }] }));
    }) as unknown as typeof fetch;
    const clients = attributionClients(spec({ "app-store": "app_ios", "google-play": "app_and" }), undefined, env);
    if ("missing" in clients) throw new Error("no clients");
    // Swap in the test fetcher.
    const { selfHostedClient } = await import("./attribution.js");
    const config = spec({ "app-store": "app_ios", "google-play": "app_and" }).attribution!;
    const source = attributionMetricSource({ "app-store": selfHostedClient(config, "t", fetcher, "app_ios"), "google-play": selfHostedClient(config, "t", fetcher, "app_and") }, new Date("2026-11-10T00:00:00Z"));
    await source.window("google-play", "com.x", "2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z");
    expect(seen.every((p) => p.includes("/v1/apps/app_and/"))).toBe(true);
    expect(attributionClient(spec({ "app-store": "app_ios" }), undefined, env, "google-play")).toEqual({ missing: "No attribution app for google-play in appeeky.spec.yaml." });
  });
  it("puts links on the Google Play app, where installs can be counted", () => {
    expect(iosOnlyLink(spec({ "app-store": "app_ios", "google-play": "app_and" }), "link_installs")).toBe(false);
    expect(iosOnlyLink(spec({ "app-store": "app_ios" }), "link_installs")).toBe(true);
  });
});

