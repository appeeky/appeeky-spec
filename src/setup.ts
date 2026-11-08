import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installedTargets } from "./agents.js";
import { SPEC_DIR, SPEC_FILE } from "./files.js";
import type { Project, StoreId } from "./schema.js";
import { normalize, words } from "./text.js";
import { STORE_CLIS, onPath } from "./transport.js";
import type { RankSource } from "./verify.js";

/*
 * First-run help: find the app, suggest targets from what it already ranks for, write the
 * GitHub workflows, and `doctor`: what is set up, what is missing and how to fix it.
 */

type Fetcher = typeof fetch;

// ── Finding the app ─────────────────────────────────────────────────────────

export interface FoundApp {
  id: string;
  name: string;
  developer: string;
  bundleId: string;
  rating?: number;
}

/** App Store apps matching a name, from Apple's public search. */
export async function findApps(term: string, country = "us", fetcher: Fetcher = fetch): Promise<FoundApp[]> {
  const url = `https://itunes.apple.com/search?media=software&entity=software&limit=6&country=${encodeURIComponent(country)}&term=${encodeURIComponent(term)}`;
  const res = await fetcher(url, { headers: { "User-Agent": "appeeky-spec" } });
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: Array<{ trackId?: number; trackName?: string; sellerName?: string; artistName?: string; bundleId?: string; averageUserRating?: number }> };
  return (json.results ?? [])
    .filter((r) => r.trackId && r.trackName)
    .map((r) => ({
      id: String(r.trackId),
      name: r.trackName!,
      developer: r.sellerName ?? r.artistName ?? "",
      bundleId: r.bundleId ?? "",
      ...(r.averageUserRating ? { rating: Math.round(r.averageUserRating * 10) / 10 } : {}),
    }));
}

/** Whether a Google Play package has a public store page. */
export async function playPackageExists(pkg: string, fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const res = await fetcher(`https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en`, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0 appeeky-spec" } });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Targets ─────────────────────────────────────────────────────────────────

/** Words nobody searches with, at the start or the end of a phrase ("AI-powered", "the best"). */
const FILLER = new Set("a an the and or for with your my our to of in on by best top new free app apps powered based simple easy fast smart ultimate official".split(" "));

/**
 * Searches the listing already speaks to: the parts of the name and subtitle between
 * punctuation ("Sleep Sounds: Rain & Ocean" → "sleep sounds", "rain", "ocean"), their two-word
 * runs, and keyword-field entries. The brand (the name's first part, alone) is left out.
 */
export function targetCandidates(project: Project, limit = 14, storeName?: string): string[] {
  const locale = project.spec.app.primaryLocale;
  const asc = project.listings["app-store"][locale] as Record<string, string | undefined> | undefined;
  const play = project.listings["google-play"][locale] ?? Object.values(project.listings["google-play"])[0];
  const name = asc?.name ?? (play as Record<string, string | undefined> | undefined)?.title ?? storeName ?? project.spec.app.name;
  const subtitle = asc?.subtitle ?? (play as Record<string, string | undefined> | undefined)?.shortDescription ?? "";
  const brand = normalize(project.spec.app.name).trim();
  const out: string[] = [];
  const add = (phrase: string) => {
    const ws = words(phrase);
    const p = ws.join(" ");
    if (!p || p.length < 3 || p === brand || out.includes(p) || ws.length > 3) return;
    if (FILLER.has(ws[0]!) || FILLER.has(ws[ws.length - 1]!)) return;
    out.push(p);
  };
  for (const text of [name, subtitle]) {
    for (const part of text.split(/[:\-–—|,&+/()]| and | for | with /i)) {
      add(part);
      const ws = words(part);
      for (let i = 0; i + 1 < ws.length; i++) add(`${ws[i]} ${ws[i + 1]}`);
    }
  }
  for (const k of (asc?.keywords ?? "").split(",")) add(k);
  return out.slice(0, limit);
}

export interface RankedCandidate {
  keyword: string;
  rank: number | null;
}

/**
 * The searches to start with: the ones the app already ranks for (a target you are near is
 * the cheapest win), best first, then two-word phrases from the listing.
 */
export async function suggestTargets(candidates: string[], appId: string | undefined, country: string, source: RankSource, count = 5): Promise<RankedCandidate[]> {
  const ranks = appId ? await source.ranks("app-store", appId, country, candidates).catch(() => ({}) as Record<string, number | null>) : {};
  const ranked = candidates.map((keyword) => ({ keyword, rank: ranks[keyword] ?? null }));
  const found = ranked.filter((r) => r.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const rest = ranked.filter((r) => r.rank === null).sort((a, b) => b.keyword.split(" ").length - a.keyword.split(" ").length);
  return [...found, ...rest].slice(0, count);
}

// ── GitHub workflows ────────────────────────────────────────────────────────

export const WORKFLOWS: Record<string, string> = {
  "listing-check.yml": `# Appeeky Spec: report listing changes on every pull request.
on: pull_request
permissions:
  contents: read
  pull-requests: write     # to comment
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0     # the report compares with main
      - uses: appeeky/appeeky-spec@v0
`,
  "listing-push.yml": `# Appeeky Spec: push the listing to the stores when a change is merged, and send the
# review replies and social posts, and make the UGC clips a merged pull request approved.
on:
  push:
    branches: [main]
    paths: ["appeeky/store/**", "appeeky.spec.yaml", "appeeky/reviews/replies/**", "appeeky/social/drafts/**", "appeeky/ugc/briefs/**"]
permissions:
  contents: write          # to commit the release file
jobs:
  push:
    runs-on: ubuntu-latest
    environment: stores    # optional: a required approval before it runs
    steps:
      - uses: actions/checkout@v4
      - run: |
          npx @appeeky/spec push --yes --note "\${{ github.event.head_commit.message }}"
          npx @appeeky/spec reviews push --yes
          npx @appeeky/spec social push --yes
          npx @appeeky/spec ugc generate --yes \${FAL_KEY:+--local}
        env:
          APPEEKY_API_KEY: \${{ secrets.APPEEKY_API_KEY }}
          FAL_KEY: \${{ secrets.FAL_KEY }}    # optional: render clips on your own fal account
      - uses: actions/upload-artifact@v4      # clips made with FAL_KEY, kept with the run
        if: hashFiles('.appeeky/media/*.mp4') != ''
        with: { name: ugc-clips, path: .appeeky/media/*.mp4 }
      - run: |
          git config user.name "appeeky-spec"
          git config user.email "spec@users.noreply.github.com"
          git add appeeky && git commit -m "Record release, replies, posts and clips" && git push || true
`,
  "listing-daily.yml": `# Appeeky Spec: record the category rank, AI visibility and Google search, measure releases on day 7 and 14, refresh reviews and competitors.
on:
  schedule: [{ cron: "0 6 * * *" }]   # 06:00 UTC
  workflow_dispatch:
permissions:
  contents: write
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          npx @appeeky/spec category pull || true
          npx @appeeky/spec visibility pull || true
          npx @appeeky/spec verify --playbook
          npx @appeeky/spec reviews pull || true
          npx @appeeky/spec competitors pull || true
          npx @appeeky/spec social pull || true
          npx @appeeky/spec ugc pull || true
          # Your own keys: Search Console with a service account, Apple Search Ads with an API user, Google ranks on
          # DataForSEO every SEO_RANKS_EVERY days (default 7), and AI visibility every N days
          # (set the repository variable VISIBILITY_EVERY, e.g. 7) on OpenAI, Anthropic, Gemini or Perplexity.
          if [ -n "$GSC_CREDENTIALS" ]; then npx @appeeky/spec seo pull || true; fi
          if [ -n "$ASA_CLIENT_ID" ]; then npx @appeeky/spec search-ads pull || true; fi
          if [ -n "$DATAFORSEO_LOGIN" ]; then npx @appeeky/spec seo ranks --every "\${SEO_RANKS_EVERY:-7}" --yes || true; fi
          if [ -n "$VISIBILITY_EVERY" ]; then npx @appeeky/spec visibility scan --local --every "$VISIBILITY_EVERY" --yes || true; fi
        env:
          APPEEKY_API_KEY: \${{ secrets.APPEEKY_API_KEY }}
          GSC_CREDENTIALS: \${{ secrets.GSC_CREDENTIALS }}
          ASA_CLIENT_ID: \${{ secrets.ASA_CLIENT_ID }}
          ASA_TEAM_ID: \${{ secrets.ASA_TEAM_ID }}
          ASA_KEY_ID: \${{ secrets.ASA_KEY_ID }}
          ASA_PRIVATE_KEY: \${{ secrets.ASA_PRIVATE_KEY }}
          DATAFORSEO_LOGIN: \${{ secrets.DATAFORSEO_LOGIN }}
          DATAFORSEO_PASSWORD: \${{ secrets.DATAFORSEO_PASSWORD }}
          SEO_RANKS_EVERY: \${{ vars.SEO_RANKS_EVERY }}
          VISIBILITY_EVERY: \${{ vars.VISIBILITY_EVERY }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          PERPLEXITY_API_KEY: \${{ secrets.PERPLEXITY_API_KEY }}
      - run: |
          git config user.name "appeeky-spec"
          git config user.email "spec@users.noreply.github.com"
          git add appeeky && git commit -m "Daily: category, AI visibility, search, Search Ads, verify, reviews, competitors, social, UGC" && git push || true
`,
};

// ── doctor ──────────────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  area: string;
  status: CheckStatus;
  detail: string;
  /** How to fix it, when it is not ok. */
  fix?: string;
}

const ok = (area: string, detail: string): DoctorCheck => ({ area, status: "ok", detail });
const warn = (area: string, detail: string, fix: string): DoctorCheck => ({ area, status: "warn", detail, fix });
const fail = (area: string, detail: string, fix: string): DoctorCheck => ({ area, status: "fail", detail, fix });

const hasLocalKeys = (store: StoreId, env: NodeJS.ProcessEnv) =>
  store === "app-store"
    ? Boolean(env.ASC_KEY_ID && (env.ASC_PRIVATE_KEY || env.ASC_PRIVATE_KEY_PATH))
    : Boolean(env.GPS_CREDENTIALS || env.GOOGLE_PLAY_CREDENTIALS || env.GOOGLE_APPLICATION_CREDENTIALS);

/** Where each store CLI keeps its saved accounts (`appstore accounts add`, `gps accounts add`). */
export function savedAccountsFile(store: StoreId, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? env.USERPROFILE ?? "", ".config");
  return join(base, store === "app-store" ? "appstore" : "gps", "config.json");
}

/** Names of the accounts saved with the store CLI, if any. */
export function savedAccounts(store: StoreId, env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const config = JSON.parse(readFileSync(savedAccountsFile(store, env), "utf8")) as { accounts?: Record<string, unknown> | unknown[] };
    const accounts = config.accounts;
    return Array.isArray(accounts) ? accounts.map((a) => String((a as { name?: string }).name ?? a)) : Object.keys(accounts ?? {});
  } catch {
    return [];
  }
}

/** What is set up for this repo, and what is missing. Works without a spec (it says so). */
export function diagnose(root: string, project: Project | null, env: NodeJS.ProcessEnv = process.env, nodeVersion = process.versions.node): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const major = Number(nodeVersion.split(".")[0]);
  out.push(major >= 20 ? ok("node", `Node ${nodeVersion}`) : fail("node", `Node ${nodeVersion}`, "Install Node 20 or newer."));
  if (!project) {
    out.push(fail("spec", `No ${SPEC_FILE} here or above`, "Run `npx @appeeky/spec init` in your app's repo."));
    return out;
  }
  out.push(ok("spec", `${SPEC_FILE} · ${project.spec.app.name}`));

  const key = Boolean(env.APPEEKY_API_KEY);
  const stores: StoreId[] = [...(project.spec.stores.appStore ? (["app-store"] as const) : []), ...(project.spec.stores.googlePlay ? (["google-play"] as const) : [])];
  if (stores.length === 0) out.push(fail("stores", "No store in the spec", "Add stores.appStore.appId or stores.googlePlay.packageName, or run `init` again."));
  for (const store of stores) {
    const cli = STORE_CLIS[store];
    const label = store === "app-store" ? "App Store" : "Google Play";
    const via = (store === "app-store" ? project.spec.stores.appStore?.via : project.spec.stores.googlePlay?.via) ?? "auto";
    const local = onPath(cli.bin, env);
    // The CLI runs from PATH or through npx; either way it reads keys from the environment or its saved accounts.
    const accounts = savedAccounts(store, env);
    const keys = hasLocalKeys(store, env) ? "keys in the environment" : accounts.length ? `saved account${accounts.length > 1 ? "s" : ""} ${accounts.join(", ")}` : "";
    const runner = local ? `${cli.bin} CLI` : `npx ${cli.npmPackage}`;
    if (via === "hosted") out.push(key ? ok(label, "hosted through your Appeeky connection (APPEEKY_API_KEY)") : fail(label, "via: hosted, but APPEEKY_API_KEY is not set", "Set APPEEKY_API_KEY (appeeky.com/dashboard/settings)."));
    else if (keys && (via === "local" || local || !key)) out.push(ok(label, `your own key: ${runner}, ${keys}`));
    else if (via !== "local" && key) out.push(ok(label, "hosted through your Appeeky connection (APPEEKY_API_KEY)"));
    else if (local) out.push(fail(label, `${cli.bin} CLI is installed but has no saved account and no keys in the environment`, cli.setupHint));
    else out.push(fail(label, `No store key saved, no ${cli.bin} CLI and no APPEEKY_API_KEY`, cli.setupHint));
    const files = Object.keys(project.listings[store]).length;
    out.push(files ? ok(`${label} listing`, `${files} locale${files === 1 ? "" : "s"} in ${SPEC_DIR}/store/${store}/`) : warn(`${label} listing`, "Not pulled yet", `Run \`npx @appeeky/spec pull --store ${store}\`.`));
  }

  const targets = Object.entries(project.spec.targets).filter(([, list]) => list.length > 0);
  const count = targets.reduce((n, [, list]) => n + list.length, 0);
  out.push(count ? ok("targets", `${count} in ${targets.map(([cc]) => cc).join(", ")}`) : fail("targets", "None yet: coverage and verify have nothing to measure", "Add the searches to win under targets:, or run `npx @appeeky/spec suggest`."));
  if (targets.length === 1) out.push(warn("control group", "Targets in one storefront only", "Add a few targets for a second country: verify compares the storefronts a release changed with the ones it did not."));

  out.push(key ? ok("Appeeky API", "APPEEKY_API_KEY set: popularity, both stores' ranks, conversion, revenue, ads") : warn("Appeeky API", "Not set: App Store ranks only, no popularity or outcome metrics", "Optional: set APPEEKY_API_KEY."));

  const attribution = project.spec.attribution;
  if (!attribution) out.push(warn("attribution", "Not set up: releases are judged on ranks and store numbers", "Optional: `npx @appeeky/spec attribution init`."));
  else if (attribution.via === "self" && !env.ATTRIBUTION_TOKEN) out.push(fail("attribution", "via: self, but ATTRIBUTION_TOKEN is not set", "Set ATTRIBUTION_TOKEN to your server's ADMIN_TOKEN."));
  else if (attribution.via === "hosted" && !key) out.push(fail("attribution", "via: hosted, but APPEEKY_API_KEY is not set", "Set APPEEKY_API_KEY."));
  else out.push(ok("attribution", `${attribution.via === "self" ? attribution.url : "Appeeky hosted"}`));

  const workflows = join(root, ".github", "workflows");
  const found = existsSync(workflows) ? readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f) && /appeeky\/appeeky-spec|@appeeky\/spec/.test(readFileSync(join(workflows, f), "utf8"))) : [];
  out.push(found.length ? ok("GitHub Actions", found.join(", ")) : warn("GitHub Actions", "No workflow runs the spec", "Optional: `npx @appeeky/spec init --ci` writes the pull request check, push on merge and daily verify."));

  const skills = [".claude/skills/appeeky-spec", ".agents/skills/appeeky-spec", ".cursor/skills/appeeky-spec"].some((p) => existsSync(join(root, p)));
  out.push(skills ? ok("agent skills", "installed") : warn("agent skills", "Not installed in this repo", "Optional: `npx skills add appeeky/appeeky-spec`."));

  const specialists = installedTargets(root);
  out.push(specialists.length ? ok("specialist agents", `installed for ${specialists.join(", ")}`) : warn("specialist agents", "Not installed: no co-founder review in this repo", "Optional: `npx @appeeky/spec agents install` (add --for opencode or all)."));

  const ignore = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "";
  if (!/\.appeeky\/?(\s|$)|\.appeeky\/data|\.appeeky\/\*/m.test(ignore)) out.push(warn(".gitignore", ".appeeky/ is not ignored: data and cache could be committed", "Add `.appeeky/` to .gitignore."));
  return out;
}
