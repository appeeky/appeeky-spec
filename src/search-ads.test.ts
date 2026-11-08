import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adsSnapshot } from "./ads.js";
import { clientSecret, cliRequest, pullSearchAds, readSearchAdsCredentials, SearchAdsClient, searchAdsMetricSource, searchAdsSource } from "./search-ads.js";
import { makeProject } from "./test-helpers.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const creds = { clientId: "SEARCHADS.abc", teamId: "SEARCHADS.abc", keyId: "k1", privateKey };

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

/** Apple's token endpoint and the parts of the Search Ads API a pull reads. */
function fakeApple(calls: Array<{ url: string; body?: Record<string, unknown>; org?: string | null }>) {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, body: init?.body && !u.includes("appleid") ? JSON.parse(String(init.body)) : undefined, org: headers["x-ap-context"] ?? null });
    if (u.includes("appleid.apple.com")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    if (u.endsWith("/acls")) return ok([{ orgId: 42, orgName: "Sleep Co" }]);
    if (u.includes("/campaigns?limit")) {
      return ok([
        { id: 1, name: "US Exact", adamId: 123, displayStatus: "RUNNING", supplySources: ["APPSTORE_SEARCH_RESULTS"] },
        { id: 2, name: "Search tab", adamId: 123, displayStatus: "RUNNING", supplySources: ["APPSTORE_SEARCH_TAB"] },
        { id: 3, name: "Other app", adamId: 999 },
      ]);
    }
    if (u.endsWith("/reports/campaigns")) {
      return ok({
        reportingDataResponse: {
          row: [
            { metadata: { campaignId: 1 }, granularity: [{ date: "2026-11-01", impressions: 100, taps: 10, totalInstalls: 4, localSpend: { amount: "8.00", currency: "EUR" } }] },
            { metadata: { campaignId: 2 }, granularity: [{ date: "2026-11-01", impressions: 50, taps: 2, totalInstalls: 1, localSpend: { amount: "2.00", currency: "EUR" } }] },
            { metadata: { campaignId: 3 }, granularity: [{ date: "2026-11-01", impressions: 999, taps: 99, totalInstalls: 99, localSpend: { amount: "99", currency: "EUR" } }] },
          ],
        },
      });
    }
    if (u.endsWith("/1/keywords")) {
      return ok({
        reportingDataResponse: {
          row: [
            { metadata: { keyword: "rain sounds", matchType: "EXACT" }, total: { impressions: 80, taps: 9, totalInstalls: 4, localSpend: { amount: "6.00", currency: "EUR" } } },
            { metadata: { keyword: "noise", matchType: "BROAD" }, total: { impressions: 20, taps: 1, totalInstalls: 0, localSpend: { amount: "2.00", currency: "EUR" } } },
          ],
        },
      });
    }
    if (u.endsWith("/1/searchterms")) {
      return ok({ reportingDataResponse: { row: [{ metadata: { searchTermText: "thunder sleep sounds" }, total: { impressions: 30, taps: 5, totalInstalls: 3, localSpend: { amount: "4.00", currency: "EUR" } } }] } });
    }
    return new Response(JSON.stringify({ error: { errors: [{ message: "unexpected" }] } }), { status: 400 });
  }) as typeof fetch;
}

describe("Apple Search Ads on your own key", () => {
  it("reads the key from ASA_* and signs an ES256 client secret", async () => {
    expect(await readSearchAdsCredentials({})).toBeNull();
    await expect(readSearchAdsCredentials({ ASA_CLIENT_ID: "c" })).rejects.toThrow("ASA_KEY_ID, ASA_PRIVATE_KEY");
    const c = await readSearchAdsCredentials({ ASA_CLIENT_ID: "c", ASA_KEY_ID: "k", ASA_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n") }, "77");
    expect(c).toMatchObject({ clientId: "c", teamId: "c", keyId: "k", orgId: "77" });
    const [head, body, sig] = clientSecret(creds, new Date("2026-11-08T00:00:00Z")).split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "ES256", kid: "k1", typ: "JWT" });
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toMatchObject({ sub: "SEARCHADS.abc", iss: "SEARCHADS.abc", aud: "https://appleid.apple.com" });
    expect(Buffer.from(sig!, "base64url")).toHaveLength(64);
  });

  it("pulls only this app's campaigns: days, keywords and search terms, and what to target", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-asa-"));
    const project = { ...makeProject({ targets: { us: ["rain sounds"] } }), root };
    const calls: Array<{ url: string; body?: Record<string, unknown>; org?: string | null }> = [];
    const r = await pullSearchAds(project, new SearchAdsClient(creds, fakeApple(calls)), new Date("2026-11-08T00:00:00Z"));
    expect(r).toMatchObject({ orgId: "42", currency: "EUR", last30: { spend: 10, installs: 5, taps: 12, impressions: 150 }, keywords: 2, searchTerms: 1, errors: [] });
    expect(r.campaigns.map((c) => c.name)).toEqual(["US Exact", "Search tab"]);
    // The search tab campaign has no keywords, so its keyword reports are not asked for.
    expect(calls.some((c) => c.url.includes("/2/"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/1/searchterms"))!.body).toMatchObject({ timeZone: "ORTZ", groupBy: ["countryOrRegion"] });
    expect(calls.filter((c) => c.url.includes("searchads")).every((c) => c.url.endsWith("/acls") || c.org === "orgId=42")).toBe(true);

    expect(readFileSync(join(root, "appeeky/search-ads/daily.csv"), "utf8")).toBe("date,spend,installs,taps,impressions,cpi,currency\n2026-11-01,10,5,12,150,2,EUR\n");
    expect(readFileSync(join(root, "appeeky/search-ads/keywords.csv"), "utf8")).toContain("rain sounds,EXACT,US Exact,80,9,4,6,1.5");
    const summary = readFileSync(join(root, "appeeky/search-ads/summary.md"), "utf8");
    expect(summary).toContain("| thunder sleep sounds | 3 | 5 | 4 EUR |");
    expect(summary).toContain("| noise | BROAD | 2 EUR | 1 |");

    const w = await searchAdsMetricSource(root)!.window("app-store", "123", "2026-11-01", "2026-11-03");
    expect(w?.values).toEqual({ ad_installs: 2.5, cpa: 2 });
    expect(w?.currency).toBe("EUR");
    const snap = await adsSnapshot(null, project.spec, { store: "app-store", appId: "123" }, 7, new Date("2026-11-03T00:00:00Z"), searchAdsMetricSource(root));
    expect(snap.channels).toEqual([{ channel: "apple-search-ads", spendPerDay: 1.43, resultsPerDay: 0.71, costPerResult: 2, result: "installs" }]);
    expect(snap.currency).toBe("EUR");
  });

  it("goes through the appstore CLI account when no ASA_* key is set", async () => {
    const project = makeProject({ stores: { appStore: { appId: "123", account: "team", searchAds: { orgId: "42" } } } });
    const calls: string[][] = [];
    const runner = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes("/api/v5/campaigns/9")) return { code: 1, stdout: JSON.stringify({ error: { message: "Apple Search Ads 404: Data not found (field: id) on GET /api/v5/campaigns/9" } }), stderr: "Apple Search Ads 404: …" };
      return { code: 0, stdout: JSON.stringify({ data: [{ id: 1, name: "US Exact", adamId: 123 }] }), stderr: "" };
    };
    const { label, source } = await searchAdsSource(project, {}, runner);
    expect(label).toBe("appstore CLI account team");
    const client = new SearchAdsClient(source as ReturnType<typeof cliRequest>);
    expect(await client.campaigns()).toEqual([{ id: 1, name: "US Exact", adamId: 123 }]);
    expect(calls[0]!.slice(-9)).toEqual(["--json", "--account", "team", "search-ads", "call", "GET", "/api/v5/campaigns?limit=1000", "--org-id", "42"]);
    expect(await client.org()).toBe("42");
    const failing = cliRequest({ account: "team", runner, useNpx: false });
    await expect(failing.request("GET", "/campaigns/9")).rejects.toThrow("Apple Search Ads 404: Data not found (field: id)");
    expect((await searchAdsSource(project, { ASA_CLIENT_ID: "c", ASA_KEY_ID: "k", ASA_PRIVATE_KEY: privateKey })).label).toBe("ASA_* key");
  });
});
