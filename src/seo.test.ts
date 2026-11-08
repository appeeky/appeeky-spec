import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blocksHome, checkSite, llmsTxt, parseRobots, pullSearchConsole, seoMetricSource } from "./seo.js";
import { makeProject } from "./test-helpers.js";

const site = (pages: Record<string, string>) =>
  (async (url: string | URL) => {
    const u = String(url);
    return u in pages ? new Response(pages[u], { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;

const project = () =>
  makeProject(
    { targets: { us: ["rain sounds", "white noise", "sleep timer"] }, web: { url: "https://sleepsounds.app/" } },
    { "en-US": { name: "Sleep Sounds: Rain & Noise", subtitle: "Fall asleep in minutes", description: "Rain, fan and ocean sounds.\n\nA timer turns them off." } },
  );

describe("robots.txt", () => {
  it("reads which agents may read the home page", () => {
    const robots = parseRobots("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\nSitemap: https://x.app/sitemap.xml");
    expect(blocksHome(robots, "GPTBot")).toBe(true);
    expect(blocksHome(robots, "ClaudeBot")).toBe(true);
    expect(blocksHome(robots, "PerplexityBot")).toBe(false);
    expect(robots.sitemaps).toEqual(["https://x.app/sitemap.xml"]);
    expect(blocksHome(parseRobots("User-agent: *\nDisallow: /\nAllow: /$"), "Googlebot")).toBe(false);
  });
});

describe("seo check", () => {
  it("flags what is missing for search, the app and AI assistants", async () => {
    const thin = `<html><head><title>Sleep</title></head><body><div id="root"></div><script>render()</script></body></html>`;
    const checks = await checkSite(
      project(),
      "https://sleepsounds.app/",
      site({ "https://sleepsounds.app/": thin, "https://sleepsounds.app/robots.txt": "User-agent: GPTBot\nDisallow: /" }),
    );
    const fails = checks.filter((c) => c.level === "fail").map((c) => c.message);
    expect(fails).toEqual(["No meta description", "robots.txt blocks GPTBot"]);
    const warn = checks.filter((c) => c.level === "warn").map((c) => c.message);
    expect(warn).toContain("No Smart App Banner");
    expect(warn).toContain("No llms.txt");
    expect(warn).toContain("0 words readable without JavaScript");
    expect(warn).toContain("0 of 3 target keywords appear on the page");
  });

  it("passes a page that has it all", async () => {
    const copy = "Sleep Sounds plays rain sounds and white noise with a sleep timer. ".repeat(20);
    const html = `<html lang="en"><head><title>Sleep Sounds: rain and white noise</title>
      <meta name="description" content="Fall asleep in minutes with rain sounds, white noise and a sleep timer. Free on iPhone and Android, no account needed.">
      <link rel="canonical" href="https://sleepsounds.app/"><meta property="og:title" content="Sleep Sounds"><meta property="og:image" content="https://sleepsounds.app/og.png">
      <meta name="apple-itunes-app" content="app-id=123">
      <script type="application/ld+json">[{"@type":"MobileApplication","name":"Sleep Sounds"},{"@type":"FAQPage"}]</script></head>
      <body><h1>Sleep Sounds</h1><p>${copy}</p><a href="https://apps.apple.com/us/app/sleep-sounds/id123">App Store</a>
      <a href="https://play.google.com/store/apps/details?id=com.example.sleep">Google Play</a></body></html>`;
    const checks = await checkSite(
      project(),
      "https://sleepsounds.app/",
      site({
        "https://sleepsounds.app/": html,
        "https://sleepsounds.app/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://sleepsounds.app/sitemap.xml",
        "https://sleepsounds.app/sitemap.xml": "<urlset></urlset>",
        "https://sleepsounds.app/llms.txt": "# Sleep Sounds\n",
      }),
    );
    expect(checks.filter((c) => c.level !== "ok")).toEqual([]);
  });
});

describe("llms.txt", () => {
  it("is written from the listing", () => {
    const text = llmsTxt(project());
    expect(text).toContain("# Sleep Sounds: Rain & Noise\n\n> Fall asleep in minutes\n\nRain, fan and ocean sounds.");
    expect(text).toContain("- [Sleep Sounds: Rain & Noise on the App Store](https://apps.apple.com/app/id123)");
    expect(text).toContain("- [Website](https://sleepsounds.app/)");
    expect(text).toContain("## Good for\n- rain sounds");
  });
});

describe("seo pull", () => {
  it("signs in with the service account and writes the days, queries and pages", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const root = mkdtempSync(join(tmpdir(), "spec-seo-"));
    const p = { ...project(), root };
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("oauth2")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      const body = JSON.parse(String(init!.body));
      bodies.push({ url: u, body });
      const dims = (body.dimensions as string[])[0];
      const rows =
        dims === "date"
          ? [
              { keys: ["2026-11-01"], clicks: 10, impressions: 200, ctr: 0.05, position: 8.2 },
              { keys: ["2026-11-02"], clicks: 12, impressions: 220, ctr: 0.054, position: 7.9 },
              { keys: ["2026-11-03"], clicks: 14, impressions: 240, ctr: 0.058, position: 7.5 },
            ]
          : dims === "query"
            ? [{ keys: ["rain sounds app"], clicks: 20, impressions: 400, ctr: 0.05, position: 6.1 }]
            : [{ keys: ["https://sleepsounds.app/"], clicks: 30, impressions: 600, ctr: 0.05, position: 7 }];
      return new Response(JSON.stringify({ rows }), { status: 200 });
    }) as typeof fetch;
    const r = await pullSearchConsole(p, { client_email: "spec@x.iam.gserviceaccount.com", private_key: privateKey }, fetcher, new Date("2026-11-08T00:00:00Z"));
    expect(r.property).toBe("sc-domain:sleepsounds.app");
    expect(bodies[0]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Asleepsounds.app/searchAnalytics/query");
    expect(bodies[0]!.body).toMatchObject({ endDate: "2026-11-06", dimensions: ["date"] });
    expect(readFileSync(join(root, "appeeky/seo/daily.csv"), "utf8")).toBe("date,clicks,impressions,ctr_pct,position\n2026-11-01,10,200,5,8.2\n2026-11-02,12,220,5.4,7.9\n2026-11-03,14,240,5.8,7.5\n");
    const summary = readFileSync(join(root, "appeeky/seo/summary.md"), "utf8");
    expect(summary).toContain("| rain sounds app | 20 | 400 | 6.1 |");
    expect(summary).toContain("## Queries with your store target keywords");
    const w = await seoMetricSource(root)!.window("app-store", "123", "2026-11-01", "2026-11-04");
    expect(w?.values).toEqual({ search_clicks: 12, search_impressions: 220 });
  });
});
