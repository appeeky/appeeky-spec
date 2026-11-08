import { createSign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_DIR } from "./files.js";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { Project } from "./schema.js";
import { rankAppIds } from "./verify.js";

/**
 * The app's website, for people searching Google and for AI assistants:
 *
 *   seo check   reads the site the way a crawler does and lists what is missing for search (title,
 *               description, canonical, sitemap), for the app (store links, smart banner, app
 *               structured data) and for AI assistants (crawlers allowed, llms.txt, text without JS)
 *   seo llms    writes llms.txt from the listing
 *   seo pull    Google Search Console clicks, impressions, queries and pages into appeeky/seo/,
 *               with your own service account (GSC_CREDENTIALS); no Appeeky account needed
 */

export const seoDir = (root: string) => join(root, SPEC_DIR, "seo");

// ── check ───────────────────────────────────────────────────────────

export type CheckArea = "search" | "app" | "ai";
export interface SiteCheck {
  area: CheckArea;
  level: "ok" | "warn" | "fail";
  message: string;
  /** What to change, when it is not ok. */
  fix?: string;
}

/** Crawlers that read sites for AI answers and training; blocking them keeps the app out of those answers. */
export const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"] as const;

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(clean);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" && value) current.allow.push(value);
    if (field === "disallow" && value) current.disallow.push(value);
  }
  return { groups, sitemaps };
}

/** Whether robots.txt keeps an agent off the home page: its own group if it has one, else the * group. */
export function blocksHome(robots: { groups: RobotsGroup[] }, agent: string): boolean {
  const a = agent.toLowerCase();
  const group = robots.groups.find((g) => g.agents.includes(a)) ?? robots.groups.find((g) => g.agents.includes("*"));
  if (!group) return false;
  const root = (r: string) => r === "/" || r === "/*" || r === "*";
  return group.disallow.some(root) && !group.allow.some((r) => root(r) || r === "/$");
}

const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((x) => x !== undefined);

function metaTags(html: string): Array<{ key: string; content: string }> {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => ({ key: (attr(m[0], "name") ?? attr(m[0], "property") ?? "").toLowerCase(), content: decode(attr(m[0], "content") ?? "") }));
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

/** The text a crawler that does not run JavaScript sees. */
export function visibleText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html.replace(/<head\b[\s\S]*?<\/head>/i, " ");
  return decode(
    body
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function jsonLdTypes(html: string): string[] {
  const types: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const t = o["@type"];
      if (typeof t === "string") types.push(t);
      if (Array.isArray(t)) types.push(...t.filter((x): x is string => typeof x === "string"));
      if (o["@graph"]) visit(o["@graph"]);
    }
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]!));
    } catch {
      types.push("(invalid JSON-LD)");
    }
  }
  return types;
}

interface Fetched {
  status: number;
  url: string;
  text: string;
  headers: Headers;
}

async function get(fetcher: typeof fetch, url: string): Promise<Fetched | null> {
  try {
    const res = await fetcher(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; AppeekySpec/1.0; +https://spec.appeeky.com)" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    return { status: res.status, url: res.url || url, text: await res.text(), headers: res.headers };
  } catch {
    return null;
  }
}

/** Read the site and list what helps or hurts it in search and in AI answers. */
export async function checkSite(project: Project, url: string, fetcher: typeof fetch = fetch): Promise<SiteCheck[]> {
  const out: SiteCheck[] = [];
  const add = (area: CheckArea, level: SiteCheck["level"], message: string, fix?: string) => out.push({ area, level, message, ...(fix && level !== "ok" ? { fix } : {}) });
  const page = await get(fetcher, url);
  if (!page) return [{ area: "search", level: "fail", message: `${url} did not answer`, fix: "Check the URL in web.url" }];
  if (page.status >= 400) return [{ area: "search", level: "fail", message: `${url} answered HTTP ${page.status}`, fix: "Check the URL in web.url" }];
  const origin = new URL(page.url).origin;
  const html = page.text;
  const metas = metaTags(html);
  const meta = (k: string) => metas.find((m) => m.key === k)?.content.trim();
  const ids = rankAppIds(project);

  // Search
  add("search", origin.startsWith("https:") ? "ok" : "fail", origin.startsWith("https:") ? "Served over HTTPS" : "Not served over HTTPS", "Serve the site over HTTPS");
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
  if (!title) add("search", "fail", "No <title>", "Give the page a title with the app's name and what it does");
  else add("search", title.length > 65 ? "warn" : "ok", `Title: "${title}" (${title.length} characters)`, "Keep the title under about 60 characters so Google shows all of it");
  const desc = meta("description");
  if (!desc) add("search", "fail", "No meta description", 'Add <meta name="description"> of 120–160 characters: what the app does and for whom');
  else add("search", desc.length < 70 || desc.length > 170 ? "warn" : "ok", `Meta description: ${desc.length} characters`, "Aim for 120–160 characters");
  const robotsMeta = `${meta("robots") ?? ""} ${page.headers.get("x-robots-tag") ?? ""}`.toLowerCase();
  if (robotsMeta.includes("noindex")) add("search", "fail", "The page asks not to be indexed (noindex)", "Remove noindex from the robots meta tag or X-Robots-Tag header");
  const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => /rel\s*=\s*["']?canonical/i.test(t));
  add("search", canonical ? "ok" : "warn", canonical ? `Canonical: ${attr(canonical, "href")}` : "No canonical link", 'Add <link rel="canonical" href="..."> with the page\'s preferred URL');
  add("search", /<html\b[^>]*\blang\s*=/i.test(html) ? "ok" : "warn", /<html\b[^>]*\blang\s*=/i.test(html) ? "Page language set" : "No lang on <html>", 'Set <html lang="en"> (or the page\'s language)');
  const h1 = (html.match(/<h1\b/gi) ?? []).length;
  add("search", h1 === 1 ? "ok" : "warn", h1 === 1 ? "One <h1>" : `${h1} <h1> headings`, "Use exactly one <h1> that says what the app does");
  add("search", meta("og:title") && meta("og:image") ? "ok" : "warn", meta("og:image") ? "Open Graph title and image" : "No Open Graph image", "Add og:title, og:description and og:image so shared links show a card");

  const robotsRes = await get(fetcher, `${origin}/robots.txt`);
  const robots = parseRobots(robotsRes && robotsRes.status < 400 ? robotsRes.text : "");
  if (blocksHome(robots, "Googlebot")) add("search", "fail", "robots.txt blocks Googlebot from the site", "Remove Disallow: / for Googlebot and *");
  const sitemapUrl = robots.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sitemap = await get(fetcher, sitemapUrl);
  const sitemapOk = sitemap && sitemap.status < 400 && /<(urlset|sitemapindex)\b/i.test(sitemap.text);
  add("search", sitemapOk ? "ok" : "warn", sitemapOk ? `Sitemap: ${sitemapUrl}` : "No sitemap found", "Publish /sitemap.xml and name it in robots.txt (Sitemap: ...)");

  // The app
  const appStoreId = ids["app-store"];
  const playId = ids["google-play"];
  if (appStoreId) {
    const linked = new RegExp(`apps\\.apple\\.com/[^"'\\s]*id${appStoreId}`).test(html);
    add("app", linked ? "ok" : "warn", linked ? "Links to the App Store listing" : "No link to the App Store listing", `Link to https://apps.apple.com/app/id${appStoreId}`);
    const banner = meta("apple-itunes-app");
    const bannerOk = banner?.includes(`app-id=${appStoreId}`);
    add("app", bannerOk ? "ok" : "warn", bannerOk ? "Smart App Banner" : "No Smart App Banner", `Add <meta name="apple-itunes-app" content="app-id=${appStoreId}"> so Safari offers the app`);
  }
  if (playId) {
    const linked = html.includes(`play.google.com/store/apps/details?id=${playId}`);
    add("app", linked ? "ok" : "warn", linked ? "Links to the Google Play listing" : "No link to the Google Play listing", `Link to https://play.google.com/store/apps/details?id=${playId}`);
  }
  const types = jsonLdTypes(html);
  const appType = types.find((t) => /^(SoftwareApplication|MobileApplication|WebApplication)$/.test(t));
  add(
    "app",
    appType ? "ok" : "warn",
    appType ? `App structured data (${appType})` : types.length ? `Structured data without the app (${[...new Set(types)].join(", ")})` : "No structured data",
    "Add JSON-LD of @type MobileApplication with name, operatingSystem, applicationCategory, offers and aggregateRating",
  );
  const text = visibleText(html);
  const name = project.spec.app.name.split(/[:\-–—|]/)[0]!.trim();
  add("app", text.toLowerCase().includes(name.toLowerCase()) ? "ok" : "warn", text.toLowerCase().includes(name.toLowerCase()) ? `The page names the app ("${name}")` : `The page text does not name "${name}"`, "Say the app's name in the page text, not only in the logo");

  // AI assistants
  const blocked = AI_CRAWLERS.filter((a) => blocksHome(robots, a));
  add("ai", blocked.length ? "fail" : "ok", blocked.length ? `robots.txt blocks ${blocked.join(", ")}` : "AI crawlers may read the site", "Allow the AI crawlers in robots.txt so assistants can read and cite the site");
  const llms = await get(fetcher, `${origin}/llms.txt`);
  const llmsOk = llms && llms.status < 400 && /^#\s/m.test(llms.text) && !/<html/i.test(llms.text);
  add("ai", llmsOk ? "ok" : "warn", llmsOk ? "llms.txt" : "No llms.txt", "Publish /llms.txt: run appeeky-spec seo llms --out public/llms.txt");
  const words = text.split(/\s+/).filter(Boolean).length;
  add("ai", words >= 150 ? "ok" : "warn", `${words} words readable without JavaScript`, "Render the page's text on the server: most AI crawlers do not run JavaScript");
  const targets = [...new Set(Object.values(project.spec.targets).flat())];
  if (targets.length) {
    const lower = text.toLowerCase();
    const found = targets.filter((k) => lower.includes(k.toLowerCase()));
    const share = found.length / targets.length;
    add("ai", share >= 0.3 ? "ok" : "warn", `${found.length} of ${targets.length} target keywords appear on the page`, "Use the phrases people search for (targets in appeeky.spec.yaml) in the page's copy, e.g. in an FAQ");
  }
  add("ai", types.includes("FAQPage") ? "ok" : "warn", types.includes("FAQPage") ? "FAQ structured data" : "No FAQ", "Answer the questions people ask assistants on the page, with FAQPage structured data");
  return out;
}

// ── llms.txt ────────────────────────────────────────────────────────

/** llms.txt from the listing: what the app is, where to get it, and the full description. */
export function llmsTxt(project: Project): string {
  const locale = project.spec.app.primaryLocale;
  const as = project.listings["app-store"][locale] ?? Object.values(project.listings["app-store"])[0];
  const gp = Object.values(project.listings["google-play"])[0];
  const ids = rankAppIds(project);
  const name = as?.name ?? gp?.title ?? project.spec.app.name;
  const summary = as?.subtitle ?? gp?.shortDescription;
  const description = (as?.description ?? gp?.fullDescription ?? "").trim();
  const links = [
    ids["app-store"] ? `- [${name} on the App Store](https://apps.apple.com/app/id${ids["app-store"]})` : null,
    ids["google-play"] ? `- [${name} on Google Play](https://play.google.com/store/apps/details?id=${ids["google-play"]})` : null,
    project.spec.web?.url ? `- [Website](${project.spec.web.url})` : null,
    as?.supportUrl ? `- [Support](${as.supportUrl})` : null,
  ].filter(Boolean);
  // The first storefront's targets: the others are other languages.
  const keywords = (Object.values(project.spec.targets)[0] ?? []).slice(0, 12);
  return [
    `# ${name}`,
    "",
    summary ? `> ${summary}` : null,
    summary ? "" : null,
    description.split(/\n\s*\n/)[0] ?? "",
    "",
    links.length ? "## Get the app" : null,
    ...links,
    links.length ? "" : null,
    keywords.length ? "## Good for" : null,
    ...keywords.map((k) => `- ${k}`),
    keywords.length ? "" : null,
    description ? "## About" : null,
    description || null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .concat("\n");
}

// ── Search Console ──────────────────────────────────────────────────

export type GoogleCredentials =
  | { type: "service_account"; client_email: string; private_key: string }
  | { type: "authorized_user"; client_id: string; client_secret: string; refresh_token: string; quota_project_id?: string };
/** @deprecated the service account shape; kept for callers that build it by hand. */
export type ServiceAccount = { client_email: string; private_key: string };

const GCLOUD_ADC = () => join(process.env.HOME ?? "", ".config", "gcloud", "application_default_credentials.json");

/**
 * GSC_CREDENTIALS (the JSON, or a path to it), else GOOGLE_APPLICATION_CREDENTIALS, else your gcloud
 * login on this machine. A service account key or an `authorized_user` file both work.
 */
export async function readServiceAccount(env: Record<string, string | undefined>, opts: { gcloud?: boolean } = {}): Promise<GoogleCredentials | null> {
  let raw = env.GSC_CREDENTIALS?.trim() || env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!raw && opts.gcloud && existsSync(GCLOUD_ADC())) raw = GCLOUD_ADC();
  if (!raw) return null;
  const text = raw.startsWith("{") ? raw : await readFile(raw, "utf8");
  const j = JSON.parse(text) as Record<string, string | undefined>;
  if (j.type === "authorized_user" && j.client_id && j.client_secret && j.refresh_token) return { type: "authorized_user", client_id: j.client_id, client_secret: j.client_secret, refresh_token: j.refresh_token, ...(j.quota_project_id ? { quota_project_id: j.quota_project_id } : {}) };
  if (j.client_email && j.private_key) return { type: "service_account", client_email: j.client_email, private_key: j.private_key };
  throw new Error("The Search Console credentials need a service account JSON key (client_email, private_key) or a gcloud application-default login.");
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export async function googleToken(creds: GoogleCredentials | ServiceAccount, fetcher: typeof fetch = fetch, now = new Date()): Promise<string> {
  let body: URLSearchParams;
  if ("type" in creds && creds.type === "authorized_user") {
    body = new URLSearchParams({ grant_type: "refresh_token", client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token });
  } else {
    const sa = creds as ServiceAccount;
    const iat = Math.floor(now.getTime() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${claims}`);
    body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64url(signer.sign(sa.private_key))}` });
  }
  const res = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  return json.access_token;
}

export function searchConsoleProperty(project: Project): string | null {
  const web = project.spec.web;
  if (!web) return null;
  return web.searchConsole ?? `sc-domain:${new URL(web.url).hostname.replace(/^www\./, "")}`;
}

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

async function query(fetcher: typeof fetch, token: string, property: string, body: Record<string, unknown>, quotaProject?: string): Promise<GscRow[]> {
  const res = await fetcher(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
    method: "POST",
    // A user login (gcloud) bills API quota to a project; a service account uses its own.
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { rows?: GscRow[]; error?: { message?: string } };
  if (!res.ok) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 403) throw new Error(`Search Console: ${msg} Make sure the account (or the service account's email) is a user of ${property} in Search Console.`);
    throw new Error(`Search Console: ${msg}`);
  }
  return json.rows ?? [];
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const csvCell = (v: string | number) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface SeoPullResult {
  property: string;
  days: number;
  last28: { clicks: number; impressions: number };
  previous28: { clicks: number; impressions: number };
  queries: number;
  pages: number;
  files: string[];
}

/** Clicks and impressions per day (merged into daily.csv), and the last 28 days by query and by page. */
export async function pullSearchConsole(project: Project, sa: GoogleCredentials | ServiceAccount, fetcher: typeof fetch = fetch, now = new Date()): Promise<SeoPullResult> {
  const property = searchConsoleProperty(project);
  if (!property) throw new Error("Set web.url in appeeky.spec.yaml (and web.searchConsole if the property is not the domain).");
  const token = await googleToken(sa, fetcher, now);
  const quota = "type" in sa && sa.type === "authorized_user" ? sa.quota_project_id : undefined;
  // Search Console data settles after about two days.
  const end = addDays(now, -2);
  const daily = await query(fetcher, token, property, { startDate: day(addDays(end, -59)), endDate: day(end), dimensions: ["date"], rowLimit: 100 }, quota);
  const from28 = day(addDays(end, -27));
  const queries = await query(fetcher, token, property, { startDate: from28, endDate: day(end), dimensions: ["query"], rowLimit: 250 }, quota);
  const pages = await query(fetcher, token, property, { startDate: from28, endDate: day(end), dimensions: ["page"], rowLimit: 100 }, quota);

  const dir = seoDir(project.root);
  await mkdir(dir, { recursive: true });
  const dailyFile = join(dir, "daily.csv");
  const rows = new Map<string, string>();
  if (existsSync(dailyFile)) for (const l of (await readFile(dailyFile, "utf8")).split("\n").slice(1).filter(Boolean)) rows.set(l.split(",")[0]!, l);
  for (const r of daily) rows.set(r.keys[0]!, [r.keys[0]!, r.clicks, r.impressions, r2(r.ctr * 100), r2(r.position)].join(","));
  await writeFile(dailyFile, `date,clicks,impressions,ctr_pct,position\n${[...rows.keys()].sort().map((k) => rows.get(k)).join("\n")}\n`);
  const table = (name: string, list: GscRow[]) => `${name},clicks,impressions,ctr_pct,position\n${list.map((r) => [csvCell(r.keys[0]!), r.clicks, r.impressions, r2(r.ctr * 100), r2(r.position)].join(",")).join("\n")}\n`;
  await writeFile(join(dir, "queries.csv"), table("query", queries));
  await writeFile(join(dir, "pages.csv"), table("page", pages));

  const sum = (from: string, to: string) =>
    daily.filter((r) => r.keys[0]! >= from && r.keys[0]! <= to).reduce((a, r) => ({ clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions }), { clicks: 0, impressions: 0 });
  const last28 = sum(from28, day(end));
  const previous28 = sum(day(addDays(end, -55)), day(addDays(end, -28)));
  const targets = [...new Set(Object.values(project.spec.targets).flat())].map((t) => t.toLowerCase());
  const nearTargets = queries.filter((q) => targets.some((t) => q.keys[0]!.toLowerCase().includes(t)));
  const close = queries.filter((q) => q.position > 3 && q.position <= 15 && q.impressions >= 20).sort((a, b) => b.impressions - a.impressions);
  const pct = (a: number, b: number) => (b > 0 ? ` (${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%)` : "");
  const lines = (list: GscRow[]) => (list.length ? list.map(line) : ["| none in this window | | | |"]);
  const line = (r: GscRow) => `| ${r.keys[0]!.replace(/\|/g, "\\|")} | ${r.clicks} | ${r.impressions} | ${r2(r.position)} |`;
  const md = [
    "# Google search",
    "",
    `Written by \`seo pull\` from Search Console (${property}), ${day(addDays(end, -27))} to ${day(end)}.`,
    "",
    `- Clicks: ${last28.clicks}${pct(last28.clicks, previous28.clicks)} vs the 28 days before`,
    `- Impressions: ${last28.impressions}${pct(last28.impressions, previous28.impressions)}`,
    "",
    "## Top queries",
    "",
    "| query | clicks | impressions | position |",
    "| --- | --- | --- | --- |",
    ...lines(queries.slice(0, 15)),
    "",
    "## Close to the top (position 4–15)",
    "",
    "A better title, description or section for these can move them onto the first screen.",
    "",
    "| query | clicks | impressions | position |",
    "| --- | --- | --- | --- |",
    ...lines(close.slice(0, 10)),
    ...(targets.length ? ["", "## Queries with your store target keywords", "", "| query | clicks | impressions | position |", "| --- | --- | --- | --- |", ...lines(nearTargets.slice(0, 10))] : []),
    "",
  ].join("\n");
  await writeFile(join(dir, "summary.md"), md);
  return { property, days: daily.length, last28, previous28, queries: queries.length, pages: pages.length, files: ["daily.csv", "queries.csv", "pages.csv", "summary.md"].map((f) => join(dir, f)) };
}

/** `search_clicks` and `search_impressions` per day from appeeky/seo/daily.csv. */
export function seoMetricSource(root: string): MetricSource | null {
  const file = join(seoDir(root), "daily.csv");
  if (!existsSync(file)) return null;
  let rows: Promise<Array<{ date: string; clicks: number; impressions: number }>> | undefined;
  return {
    label: "Google Search Console in the repo",
    async window(_store, _appId, from, to) {
      rows ??= readFile(file, "utf8").then((t) =>
        t
          .split("\n")
          .slice(1)
          .filter(Boolean)
          .map((l) => {
            const [date, clicks, impressions] = l.split(",");
            return { date: date!, clicks: Number(clicks), impressions: Number(impressions) };
          }),
      );
      const inside = (await rows).filter((r) => r.date >= from && r.date < to);
      if (inside.length < 3) return null;
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
      const values: MetricWindow["values"] = {
        search_clicks: inside.reduce((n, r) => n + r.clicks, 0) / inside.length,
        search_impressions: inside.reduce((n, r) => n + r.impressions, 0) / inside.length,
      };
      return { from, to, days, values };
    },
  };
}
