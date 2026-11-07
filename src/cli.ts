import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { adsSnapshot, CHANNEL_LABELS, saveAdsSnapshot } from "./ads.js";
import { attributionClient, attributionClients, attributionMetricSource, createExperimentLink, hasClients, IOS_LINK_NOTE, iosOnlyLink, isClient, linkResult, linkStore } from "./attribution.js";
import { pullCompetitors, similarApps } from "./competitors.js";
import { categoryFile, categoryMetricSource, categoryPlans, chartSources, previousRank, readCategoryHistory, readCategoryRanks, saveCategoryRanks } from "./category.js";
import { applySync, bootstrapIntents, languageFor, planSync, pullVisibility, readRemoteIntents, scanVisibility, visibilityMetricSource, visibilityTarget } from "./visibility.js";
import { attributionBlock, initHosted, initSelfHosted, nextSteps, specStores } from "./attribution-setup.js";
import { pullData } from "./data.js";
import { combineSources } from "./metrics.js";
import { fetchReviews, readReplies, readReviews, replyIssues, reviewMetricSource, saveReviews, sendReply, writeReply, writeSummary } from "./reviews.js";
import { AppeekyApi, appeekyRankSource, loadPopularity, metricSourceFor } from "./appeeky-api.js";
import { closeExperiment, dueExperiments, experimentId, readExperiments, writeExperiment, type Experiment } from "./experiments.js";
import { appendPlaybook, experimentApp, measureExperiments, playbookLine, verifyReleases } from "./measure.js";
import { formatChange, isMetricName, METRICS, metricAfter, metricBefore, type MetricName } from "./metrics.js";
import { loadProjectAtRef, specReport } from "./report.js";
import { checkScreenshots, pullScreenshots } from "./screenshots.js";
import { appendKeyword, crossLocalizationSuggestions, keywordSuggestions } from "./suggest.js";
import { firstRankSource, itunesRankSource, rankAppIds, snapshotRanks, type RankSource } from "./verify.js";
import { AppStoreAdapter } from "./stores/app-store.js";
import { projectCoverage } from "./coverage.js";
import { invertChanges } from "./diff.js";
import { loadProject, recordPull, SPEC_DIR, SPEC_FILE, writeListing, writeSpec } from "./files.js";
import { readReleases, releaseId, releaseMarkdown, writeRelease } from "./history.js";
import { freeStores, writeLoops, type Loop } from "./loops.js";
import { diagnose, findApps, playPackageExists, suggestTargets, targetCandidates, WORKFLOWS, type DoctorCheck } from "./setup.js";
import { hasErrors, lintProject } from "./lint.js";
import { c, formatChanges, formatCoverage, formatIssues, printJson, storeLabel } from "./output.js";
import { configuredStores, planStore, storeHandle, type StorePlan } from "./project.js";
import { STORES, type Listing, type Project, type SpecFileInput, type StoreId, type TransportMode } from "./schema.js";

const round = (v: number | undefined) => (v === undefined ? "?" : Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2));

/** One playbook line for a closed experiment. */
function experimentPlaybookLine(e: Experiment): string {
  const value = e.result?.value !== undefined ? ` (${e.metric} ${round(e.baseline)} → ${round(e.result.value)})` : "";
  return `- ${e.startedAt.slice(0, 10)}, ${e.type}${e.persona ? `, ${e.persona}` : ""}: ${e.hypothesis} → ${e.status}${value}${e.result?.note ? `. ${e.result.note}` : ""}`;
}
import type { TransportOptions } from "./transport.js";
import { STORE_CLIS } from "./transport.js";

interface GlobalOpts {
  cwd: string;
  json: boolean;
  via?: TransportMode;
}

const PLAYBOOK = `# Playbook

What worked and what did not for this app. Appeeky Spec and your agent read this
before proposing a change, so keep each entry short and specific:

- YYYY-MM-DD, store, locale: what changed → what happened (and how sure we are)
`;

/** An account name from the app name: "Sleep Sounds" → "sleep-sounds". */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";

/** One line of input; Enter gives `fallback`. */
async function ask(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question}${fallback ? c.dim(` (${fallback})`) : ""} `);
  rl.close();
  return answer.trim() || fallback;
}

/** A yes/no question that defaults to yes. */
async function agree(question: string): Promise<boolean> {
  return !/^n(o)?$/i.test(await ask(`${question} [Y/n]`));
}

/** Keep the private data and cache out of git. */
async function ignoreLocalData(root: string): Promise<boolean> {
  const file = join(root, ".gitignore");
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  if (/^\.appeeky\/?\s*$/m.test(current)) return false;
  await writeFile(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n# Appeeky Spec: your analytics, cache and history stay local\n.appeeky/\n`);
  return true;
}

/** Write the GitHub workflows that are not there yet. */
async function writeWorkflows(root: string): Promise<string[]> {
  const dir = join(root, ".github", "workflows");
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [file, body] of Object.entries(WORKFLOWS)) {
    if (existsSync(join(dir, file))) continue;
    await writeFile(join(dir, file), body);
    written.push(`.github/workflows/${file}`);
  }
  return written;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function storeOption() {
  return new Option("-s, --store <store>", "Only this store").choices([...STORES]);
}

export function buildProgram(): Command {
  const program = new Command()
    .name("appeeky-spec")
    .description("Your app's store listing as a spec: check it, measure keyword coverage, diff it with the live store and push it.")
    .version("0.1.0")
    .option("-C, --cwd <dir>", "Run as if started in this folder", process.cwd())
    .option("--json", "Machine-readable output", false)
    .addOption(new Option("--via <mode>", "How to reach the stores (overrides the spec)").choices(["auto", "local", "hosted"]));

  const g = () => program.opts<GlobalOpts>();
  const transportOverrides = (): Partial<TransportOptions> => (g().via ? { via: g().via } : {});
  const load = () => loadProject(g().cwd);
  const api = () => (process.env.APPEEKY_API_KEY ? new AppeekyApi(process.env.APPEEKY_API_KEY, { baseUrl: process.env.APPEEKY_API_URL }) : undefined);
  /** Appeeky API ranks when a key is set (both stores), Apple's public search otherwise (App Store only). */
  const rankSource = (): RankSource => {
    const a = api();
    return a ? firstRankSource(appeekyRankSource(a), itunesRankSource()) : itunesRankSource();
  };

  program
    .command("init")
    .description(`Create ${SPEC_FILE} and the appeeky/ folder. With no options in a terminal, a guided setup`)
    .option("--name <name>", "App name")
    .option("--app-store <appId>", "App Store app id (numeric) or bundle id")
    .option("--google-play <package>", "Google Play package name")
    .option("--locale <locale>", "Primary locale", "en-US")
    .option("--country <cc>", "First storefront to add targets for", "us")
    .option("--pull", "Pull the live listings right away", false)
    .option("--ci", "Write the GitHub workflows (pull request check, push on merge, daily verify); works on an existing spec too", false)
    .action(async (opts: { name?: string; appStore?: string; googlePlay?: string; locale: string; country: string; pull: boolean; ci: boolean }) => {
      const root = resolve(g().cwd);
      const exists = existsSync(join(root, SPEC_FILE));
      if (exists && opts.ci) {
        const written = await writeWorkflows(root);
        if (g().json) printJson({ workflows: written });
        else console.log(written.length ? written.map((f) => `${c.green("Wrote")} ${f}`).join("\n") : c.dim("The workflows are already there."));
        return;
      }
      if (exists) throw new Error(`${SPEC_FILE} already exists in ${root}. Run \`appeeky-spec doctor\` to see what is set up.`);
      const guided = !opts.name && !opts.appStore && !opts.googlePlay && process.stdin.isTTY && !g().json;
      if (guided) return wizard(root, opts.locale, opts.country);
      const spec: SpecFileInput = {
        version: 1,
        app: { name: opts.name ?? "My App", primaryLocale: opts.locale },
        stores: {
          ...(opts.appStore ? { appStore: { appId: opts.appStore, via: "auto" } } : {}),
          ...(opts.googlePlay ? { googlePlay: { packageName: opts.googlePlay, via: "auto" } } : {}),
        },
        targets: { [opts.country.toLowerCase()]: [] },
      };
      await writeSpec(root, spec);
      await mkdir(join(root, SPEC_DIR, "store"), { recursive: true });
      if (!existsSync(join(root, SPEC_DIR, "playbook.md"))) await writeFile(join(root, SPEC_DIR, "playbook.md"), PLAYBOOK);
      await ignoreLocalData(root);
      const workflows = opts.ci ? await writeWorkflows(root) : [];
      if (!g().json) {
        console.log(`${c.green("Created")} ${SPEC_FILE} and ${SPEC_DIR}/`);
        for (const f of workflows) console.log(`${c.green("Wrote")} ${f}`);
        if (!opts.appStore && !opts.googlePlay) console.log(c.dim("Add stores.appStore.appId or stores.googlePlay.packageName, then run `appeeky-spec pull`."));
      }
      if (opts.pull && (opts.appStore || opts.googlePlay)) await program.parseAsync(["pull"], { from: "user" });
      else if (g().json) printJson({ root, created: [SPEC_FILE, `${SPEC_DIR}/`, ...workflows] });
    });

  /**
   * The guided setup: find the app, write the spec, check that the stores can be reached and
   * pull, suggest targets from what it already ranks for, add CI and the agent skills, and
   * end on the first coverage table.
   */
  async function wizard(root: string, locale: string, country: string) {
    const step = (n: number, title: string) => console.log(`\n${c.bold(`${n}/6`)} ${title}`);
    console.log(c.bold("Appeeky Spec setup") + c.dim("  Enter keeps the suggestion in brackets."));

    step(1, "Your app");
    const term = await ask("What is it called on the App Store?");
    const found = term ? await findApps(term, country).catch(() => []) : [];
    let appStore: string | undefined;
    let name = term || "My App";
    let storeName = term;
    let bundleId = "";
    if (found.length) {
      found.forEach((app, i) => console.log(`  ${c.cyan(String(i + 1))}  ${app.name}  ${c.dim(`${app.developer}${app.rating ? ` · ${app.rating}★` : ""} · ${app.id}`)}`));
      console.log(`  ${c.cyan("0")}  ${c.dim("None of these / not on the App Store")}`);
      const pick = Number(await ask("Which one?", "1"));
      const app = found[pick - 1];
      if (app) {
        appStore = app.id;
        name = app.name.split(/[:\-–—|]/)[0]!.trim() || app.name;
        storeName = app.name;
        bundleId = app.bundleId;
      }
    } else if (term) console.log(c.dim("  Not found on the App Store in this country."));
    if (!appStore) {
      const id = await ask("App Store id (digits), or Enter to skip:");
      if (/^\d{5,}$/.test(id)) appStore = id;
    }
    let googlePlay: string | undefined;
    const pkg = await ask("Google Play package, or - for none:", bundleId || "-");
    if (pkg && pkg !== "-") {
      const live = await playPackageExists(pkg);
      console.log(live ? `  ${c.green("✓")} found on Google Play` : `  ${c.yellow("!")} no public Google Play page for ${pkg}: kept, check the name`);
      googlePlay = pkg;
    }
    if (!appStore && !googlePlay) throw new Error("Give an App Store id or a Google Play package to set up the spec.");

    step(2, "The spec");
    await writeSpec(root, {
      version: 1,
      app: { name, primaryLocale: locale },
      stores: {
        ...(appStore ? { appStore: { appId: appStore, via: "auto" } } : {}),
        ...(googlePlay ? { googlePlay: { packageName: googlePlay, via: "auto" } } : {}),
      },
      targets: { [country]: [] },
    });
    await mkdir(join(root, SPEC_DIR, "store"), { recursive: true });
    if (!existsSync(join(root, SPEC_DIR, "playbook.md"))) await writeFile(join(root, SPEC_DIR, "playbook.md"), PLAYBOOK);
    const ignored = await ignoreLocalData(root);
    console.log(`  ${c.green("✓")} ${SPEC_FILE}, ${SPEC_DIR}/playbook.md${ignored ? ", .appeeky/ in .gitignore" : ""}`);

    step(3, "Store access and your live listing");
    let project = await load();
    let reach = diagnose(root, project).filter((x) => x.area === "App Store" || x.area === "Google Play");
    printChecks(reach);
    // A store that cannot be reached: offer to save the user's own key with the store CLI, once per machine.
    let saved = false;
    for (const x of reach.filter((r) => r.status === "fail")) {
      const store: StoreId = x.area === "App Store" ? "app-store" : "google-play";
      if (!(await agree(`Save your own ${x.area} key on this machine now?`))) continue;
      saved = (await saveStoreKey(store, slug(name), store === "app-store" ? appStore : googlePlay)) || saved;
    }
    if (saved) {
      reach = diagnose(root, project).filter((x) => x.area === "App Store" || x.area === "Google Play");
      printChecks(reach);
    }
    let pulled = false;
    // Pull each store that can be reached, one at a time: one store's problem does not stop the other.
    const reachable = reach.filter((x) => x.status === "ok").map((x) => (x.area === "App Store" ? "app-store" : "google-play"));
    if (reachable.length && (await agree(`Pull your live listing from ${reachable.map((s) => storeLabel(s as StoreId)).join(" and ")} now?`))) {
      for (const store of reachable) {
        try {
          await program.parseAsync(["pull", "--store", store], { from: "user" });
          pulled = true;
        } catch (e) {
          console.log(`  ${c.red("✗")} ${(e as Error).message}`);
        }
      }
    }
    if (reachable.length < reach.length) console.log(c.dim("  Set up access for the rest as above, then run `appeeky-spec pull`."));

    step(4, `The searches to win in ${country.toUpperCase()}`);
    project = await load();
    // Without a pulled listing, the App Store name still says what the app is for.
    const candidates = targetCandidates(project, 14, storeName);
    const ranked = await suggestTargets(candidates, appStore, country, itunesRankSource());
    let targets: string[] = [];
    if (ranked.length) {
      for (const r of ranked) console.log(`  ${r.keyword.padEnd(24)} ${r.rank ? c.green(`#${r.rank}`) : c.dim("not in the top 200")}`);
      const answer = await ask("Keep these? Enter for yes, or type your own, comma separated:", "yes");
      targets = answer === "yes" ? ranked.map((r) => r.keyword) : answer.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    } else {
      const answer = await ask("Type 3 to 5 searches people use to find apps like yours, comma separated:");
      targets = answer.split(",").map((x) => x.trim().toLowerCase()).filter((x) => x && !/^(y|yes)$/.test(x));
    }
    if (targets.length) {
      project.spec.targets[country] = targets;
      await writeSpec(root, project.spec);
      console.log(`  ${c.green("✓")} ${targets.length} ${targets.length === 1 ? "target" : "targets"} in ${SPEC_FILE}`);
    }

    step(5, "Automation");
    if (existsSync(join(root, ".git")) && (await agree("Add GitHub Actions (pull request check, push on merge, daily verify)?"))) {
      for (const f of await writeWorkflows(root)) console.log(`  ${c.green("✓")} ${f}`);
      console.log(c.dim("  The push and the daily run need APPEEKY_API_KEY (or your store keys) as repository secrets."));
    }
    if (await agree("Install the agent skills (npx skills add appeeky/appeeky-spec)?")) {
      const result = spawnSync("npx", ["-y", "skills", "add", "appeeky/appeeky-spec"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
      if (result.status !== 0) console.log(c.yellow("  The skills did not install. Run `npx skills add appeeky/appeeky-spec` later."));
    }

    step(6, "Where you stand");
    if (pulled && targets.length) await program.parseAsync(["coverage", "--country", country], { from: "user" });
    else console.log(c.dim("  Pull the listing and add targets, then `appeeky-spec coverage` shows which searches it covers."));
    console.log(`\n${c.bold("Next")}: change a listing file (or ask your agent), then ${c.cyan("appeeky-spec diff")} and ${c.cyan('appeeky-spec push --note "why"')}.`);
    console.log(c.dim("Run `appeeky-spec doctor` any time to see what is set up and what is missing."));
  }

  /**
   * Save a store key with the store's own CLI (`appstore accounts add`, `gps accounts add`), run
   * through npx: the key stays in the CLI's config on this machine, never in the repo.
   */
  async function saveStoreKey(store: StoreId, account: string, appId?: string): Promise<boolean> {
    const cli = STORE_CLIS[store];
    let args: string[];
    if (store === "app-store") {
      console.log(c.dim("  App Store Connect → Users and Access → Integrations → App Store Connect API. Role App Manager to push."));
      const keyId = await ask("  Key ID:");
      const issuer = await ask("  Issuer ID (Enter for an individual key):");
      const path = await ask("  Path to the AuthKey_….p8 file:");
      if (!keyId || !path) return false;
      args = ["accounts", "add", account, "--key-id", keyId, ...(issuer ? ["--issuer-id", issuer] : []), "--private-key-path", path, ...(appId ? ["--default-app", appId] : []), "--default"];
    } else {
      console.log(c.dim("  A Google Cloud service account with the Android Publisher API, invited in Play Console → Users and permissions."));
      const path = await ask("  Path to its JSON key:");
      if (!path) return false;
      args = ["accounts", "add", account, "--credentials", path, ...(appId ? ["--default-package", appId] : []), "--default"];
    }
    const result = spawnSync("npx", ["-y", "-p", cli.npmPackage, cli.bin, ...args], { stdio: "inherit", shell: process.platform === "win32" });
    if (result.status === 0) {
      console.log(`  ${c.green("✓")} saved as "${account}" in the ${cli.bin} CLI's config (not in this repo)`);
      return true;
    }
    console.log(`  ${c.red("✗")} ${cli.bin} accounts add failed: run it again later with the command above.`);
    return false;
  }

  function printChecks(checks: DoctorCheck[]) {
    const mark = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") } as const;
    for (const x of checks) {
      console.log(`  ${mark[x.status]} ${x.area.padEnd(20)} ${x.detail}`);
      if (x.fix) console.log(`    ${c.dim(x.fix)}`);
    }
  }

  program
    .command("doctor")
    .description("What is set up for this repo, what is missing, and how to fix it")
    .action(async () => {
      const root = resolve(g().cwd);
      const project = await load().catch(() => null);
      const checks = diagnose(project?.root ?? root, project);
      if (g().json) printJson({ checks });
      else {
        printChecks(checks);
        const fails = checks.filter((x) => x.status === "fail").length;
        const warns = checks.filter((x) => x.status === "warn").length;
        console.log(`\n${fails ? c.red(`${fails} to fix`) : c.green("Ready")}${warns ? c.dim(` · ${warns} optional`) : ""}`);
      }
      if (checks.some((x) => x.status === "fail")) process.exitCode = 1;
    });

  program
    .command("pull")
    .description("Write the live store listings into appeeky/store/ (overwrites local files)")
    .addOption(storeOption())
    .option("--locale <locales...>", "Only these locales")
    .action(async (opts: { store?: StoreId; locale?: string[] }) => {
      const project = await load();
      const written: Array<{ store: StoreId; locale: string; file: string }> = [];
      for (const store of configuredStores(project, opts.store)) {
        const handle = storeHandle(project, store, transportOverrides());
        if (!g().json) console.log(c.dim(`${storeLabel(store)}: pulling via ${handle.transport.label}…`));
        const state = await handle.adapter.pull();
        for (const [locale, listing] of Object.entries(state.listings)) {
          if (opts.locale && !opts.locale.includes(locale)) continue;
          written.push({ store, locale, file: await writeListing(project.root, store, locale, listing as Listing) });
        }
        await recordPull(project.root, store, state.target);
        if (!g().json) console.log(`${storeLabel(store)}: ${Object.keys(state.listings).length} locales from ${state.target}`);
      }
      if (g().json) printJson({ written });
    });

  program
    .command("check")
    .alias("lint")
    .description("Check the listings against store limits and ASO rules")
    .option("--strict", "Fail on warnings too", false)
    .action(async (opts: { strict: boolean }) => {
      const project = await load();
      const issues = [...lintProject(project), ...(await checkScreenshots(project.root))];
      if (g().json) printJson({ issues });
      else console.log(formatIssues(issues));
      if (hasErrors(issues) || (opts.strict && issues.some((i) => i.severity === "warning"))) process.exitCode = 1;
    });

  program
    .command("coverage")
    .description("Which target keywords the listings index, per storefront")
    .option("--country <cc...>", "Only these storefronts")
    .option("--no-metrics", "Skip popularity from the Appeeky API")
    .action(async (opts: { country?: string[]; metrics: boolean }) => {
      const project = await load();
      const key = process.env.APPEEKY_API_KEY;
      const targets = Object.fromEntries(
        Object.entries(project.spec.targets).filter(([cc]) => !opts.country || opts.country.map((x) => x.toLowerCase()).includes(cc)),
      );
      const scoped: Project = { ...project, spec: { ...project.spec, targets } };
      const stores = configuredStores(project);
      let lookup;
      let note: string | undefined;
      if (opts.metrics) {
        const result = await loadPopularity(project.root, key ? new AppeekyApi(key, { baseUrl: process.env.APPEEKY_API_URL }) : undefined, targets, stores, (done, total) => {
          if (!g().json && process.stderr.isTTY) process.stderr.write(`\r${c.dim(`popularity ${done}/${total}`)}`);
        });
        if (!g().json && process.stderr.isTTY && result.fetched > 0) process.stderr.write("\r\u001b[K");
        lookup = result.lookup;
        if (!key) note = "Set APPEEKY_API_KEY to rank targets by search popularity (appeeky.com/dashboard/settings).";
        else if (result.failed.length > 0) note = `Popularity missing for ${result.failed.length} keywords: ${result.failed[0]}`;
      }
      const reports = projectCoverage(scoped, lookup);
      const crossLocalization = crossLocalizationSuggestions(scoped);
      if (g().json) printJson({ coverage: reports, crossLocalization, note });
      else {
        console.log(formatCoverage(reports));
        for (const x of crossLocalization) {
          const split = x.splitPhrase ? "separate its keyword field with commas and " : "";
          console.log(`\n${c.cyan("tip")}  ${x.country.toUpperCase()} also indexes ${x.locale}: ${split}add ${x.add.map((w) => `"${w}"`).join(", ")} to its keyword field → ${c.dim(x.keywords)}`);
        }
        if (note) console.log(c.dim(`\n${note}`));
      }
    });

  const plans = async (project: Project, only?: StoreId): Promise<StorePlan[]> => {
    const out: StorePlan[] = [];
    for (const store of configuredStores(project, only)) out.push(await planStore(project, storeHandle(project, store, transportOverrides())));
    return out;
  };

  program
    .command("diff")
    .description("Compare the spec with the live store")
    .addOption(storeOption())
    .action(async (opts: { store?: StoreId }) => {
      const project = await load();
      const result = await plans(project, opts.store);
      if (g().json) {
        printJson({ stores: result.map((p) => ({ store: p.store, via: p.via, target: p.state.target, changes: p.changes })) });
        return;
      }
      for (const p of result) {
        console.log(c.dim(`${storeLabel(p.store)}: ${p.state.target} via ${p.via}`));
        console.log(formatChanges(p.changes));
      }
    });

  program
    .command("push")
    .description("Push the spec to the stores and record a release in appeeky/releases/")
    .addOption(storeOption())
    .option("-y, --yes", "Do not ask for confirmation", false)
    .option("--dry-run", "Show what would be pushed", false)
    .option("-m, --note <text>", "Why this change: stored with the release")
    .option("--force", "Push even when `check` finds errors", false)
    .option("--create-version <version>", "Create this App Store version first (name, subtitle and keywords need one)")
    .option("--no-baseline", "Do not record search ranks before pushing")
    .action(async (opts: { store?: StoreId; yes: boolean; dryRun: boolean; note?: string; force: boolean; createVersion?: string; baseline: boolean }) => {
      const project = await load();
      if (opts.createVersion && !opts.dryRun && project.spec.stores.appStore && (!opts.store || opts.store === "app-store")) {
        const handle = storeHandle(project, "app-store", transportOverrides());
        const created = await (handle.adapter as AppStoreAdapter).createVersion(opts.createVersion);
        if (!g().json) console.log(`${c.green("Created")} App Store version ${created.versionString}`);
      }
      const issues = lintProject(project).filter((i) => i.severity === "error");
      if (issues.length > 0 && !opts.force) {
        if (g().json) printJson({ error: "check_failed", issues });
        else console.error(`${formatIssues(issues)}\n\n${c.red("Fix these first, or pass --force.")}`);
        process.exitCode = 1;
        return;
      }
      const result = await plans(project, opts.store);
      const pushable = result.flatMap((p) => p.changes.filter((ch) => !ch.blocked));
      if (!g().json) {
        for (const p of result) {
          console.log(c.dim(`${storeLabel(p.store)}: ${p.state.target} via ${p.via}`));
          console.log(formatChanges(p.changes));
        }
      }
      if (pushable.length === 0 || opts.dryRun) {
        if (g().json) printJson({ dryRun: opts.dryRun, stores: result.map((p) => ({ store: p.store, target: p.state.target, changes: p.changes })) });
        else if (pushable.length === 0) console.log(c.dim("\nNothing to push."));
        return;
      }
      if (!opts.yes && !(await confirm(`\nPush ${pushable.length} change${pushable.length === 1 ? "" : "s"}?`))) {
        if (!process.stdin.isTTY && !g().json) console.error(c.yellow("Not a terminal: pass --yes to push."));
        process.exitCode = 1;
        return;
      }
      const releases = [];
      for (const p of result) {
        const ready = p.changes.filter((ch) => !ch.blocked);
        if (ready.length === 0) continue;
        const handle = storeHandle(project, p.store, transportOverrides());
        // Ranks right before the push are what `verify` compares against later.
        const baseline = opts.baseline && rankAppIds(project)[p.store] ? await snapshotRanks(project, rankSource(), [p.store]).catch(() => null) : null;
        const pushed = await handle.adapter.push(ready, p.state, project.listings[p.store] as Record<string, Listing>);
        const now = new Date();
        const record = {
          id: releaseId(now, p.store),
          pushedAt: now.toISOString(),
          store: p.store,
          target: p.state.target,
          via: p.via,
          ...(opts.note ? { note: opts.note } : {}),
          changes: pushed.applied.map(({ locale, field, before, after }) => ({ locale, field, before, after })),
          ...(baseline?.ranks[p.store] ? { baseline: { at: baseline.at, source: baseline.source, ranks: baseline.ranks[p.store]! } } : {}),
        };
        const file = await writeRelease(project.root, record);
        releases.push({ ...record, file, skipped: pushed.skipped });
        if (!g().json) console.log(`${c.green("Pushed")} ${pushed.applied.length} to ${storeLabel(p.store)} · ${c.dim(file)}`);
      }
      if (releases.length) await writeLoops(project.root);
      if (g().json) printJson({ releases });
    });

  program
    .command("status")
    .description("Every change being measured: what, the metric that decides it, the next check and the result so far")
    .option("--all", "Show closed loops too", false)
    .action(async (opts: { all: boolean }) => {
      const project = await load();
      const loops = await writeLoops(project.root);
      const stores = [...(project.spec.stores.appStore ? (["app-store"] as const) : []), ...(project.spec.stores.googlePlay ? (["google-play"] as const) : [])];
      const free = freeStores(loops, stores);
      if (g().json) {
        printJson({ loops, free });
        return;
      }
      const shown = opts.all ? loops : loops.filter((l) => l.state !== "closed");
      if (shown.length === 0) console.log(c.dim(opts.all ? "No releases or experiments yet." : "Nothing is being measured. See closed loops with --all."));
      for (const l of shown) printLoop(l);
      const closed = loops.length - loops.filter((l) => l.state !== "closed").length;
      if (!opts.all && closed) console.log(c.dim(`\n${closed} closed. --all to see them.`));
      console.log(free.length ? `\n${c.green("Free to change:")} ${free.map(storeLabel).join(", ")}` : c.dim("\nEvery store has a release being measured: wait before the next change."));
      console.log(c.dim("Written to appeeky/loops.md."));
    });

  program
    .command("log")
    .description("Releases pushed from this spec, newest first")
    .option("-n, --limit <n>", "How many", "20")
    .option("--markdown", "Print each release as a Markdown summary", false)
    .action(async (opts: { limit: string; markdown: boolean }) => {
      const project = await load();
      const releases = (await readReleases(project.root)).slice(0, Number(opts.limit) || 20);
      if (opts.markdown) {
        console.log(releases.map(releaseMarkdown).join("\n\n"));
        return;
      }
      if (g().json) {
        printJson({ releases });
        return;
      }
      if (releases.length === 0) console.log(c.dim("No releases yet."));
      for (const r of releases) {
        const locales = [...new Set(r.changes.map((ch) => ch.locale))];
        console.log(`${c.bold(r.id)}  ${storeLabel(r.store)} · ${r.target} · ${r.changes.length} changes in ${locales.join(", ")}`);
        if (r.note) console.log(`  ${c.dim(r.note)}`);
      }
    });

  program
    .command("ads")
    .description("Spend and installs of your paid channels: Apple Search Ads, plus the Meta and TikTok campaigns under ads: (needs APPEEKY_API_KEY)")
    .option("--days <n>", "How many days, up to yesterday", "30")
    .option("--save", "Write the numbers to appeeky/ads/<date>.yaml", false)
    .action(async (opts: { days: string; save: boolean }) => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: ad data comes from the channels you connected in Appeeky.");
      const snapshot = await adsSnapshot(a, project.spec, experimentApp(project, {}), Number(opts.days) || 30);
      const saved = opts.save ? await saveAdsSnapshot(project.root, snapshot) : undefined;
      if (g().json) {
        printJson({ ...snapshot, ...(saved ? { saved } : {}) });
        return;
      }
      const money = (n: number | undefined) => (n === undefined ? "—" : `${snapshot.currency && snapshot.currency !== "USD" ? `${snapshot.currency} ` : "$"}${n.toFixed(2)}`);
      console.log(c.dim(`${snapshot.from} → ${snapshot.to} (${snapshot.days} days, per day)`));
      if (snapshot.channels.length === 0 && snapshot.errors.length === 0) {
        console.log(c.dim("No ad data. Connect Apple Search Ads, Meta or TikTok in Appeeky, and list Meta and TikTok campaign ids under ads: in appeeky.spec.yaml."));
      }
      for (const ch of snapshot.channels) {
        console.log(
          `${c.bold(CHANNEL_LABELS[ch.channel].padEnd(18))} spend ${money(ch.spendPerDay).padEnd(10)} ${ch.result} ${String(ch.resultsPerDay ?? "—").padEnd(8)} cost per ${ch.result === "installs" ? "install" : "conversion"} ${money(ch.costPerResult)}`,
        );
      }
      for (const e of snapshot.errors) console.log(`${c.red(CHANNEL_LABELS[e.channel].padEnd(18))} ${c.dim(e.message)}`);
      if (saved) console.log(c.dim(`\nSaved ${saved.replace(project.root + "/", "")}`));
    });

  const reviews = program.command("reviews").description("Customer reviews in the repo, and replies sent through a pull request (needs APPEEKY_API_KEY)");
  reviews
    .command("pull")
    .description("Write App Store and Google Play reviews to appeeky/reviews/ and update summary.md")
    .option("--since <date>", "Only reviews from this date on (default: everything the connection has)")
    .option("--max <n>", "At most this many reviews per store", "2000")
    .action(async (opts: { since?: string; max: string }) => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: reviews come from the store connections in Appeeky.");
      const ids = rankAppIds(project);
      const results: Record<string, { fetched: number; added: number; updated: number } | { error: string }> = {};
      for (const store of Object.keys(ids) as StoreId[]) {
        try {
          const got = await fetchReviews(a, store, ids[store]!, { since: opts.since, max: Number(opts.max) || 2000 });
          results[store] = { fetched: got.length, ...(await saveReviews(project.root, got)) };
        } catch (e) {
          results[store] = { error: (e as Error).message };
        }
      }
      // Every listing's text, so the summary can show what users say that it does not.
      const listingText = Object.values(project.listings)
        .flatMap((byLocale) => Object.values(byLocale))
        .flatMap((l) => Object.values(l as Record<string, unknown>).filter((v): v is string => typeof v === "string"))
        .join(" ");
      const summary = await writeSummary(project.root, new Date(), listingText);
      if (g().json) {
        printJson({ results, summary });
        return;
      }
      for (const [store, r] of Object.entries(results)) {
        if ("error" in r) console.log(`${c.red(storeLabel(store as StoreId).padEnd(12))} ${c.dim(r.error)}`);
        else console.log(`${c.bold(storeLabel(store as StoreId).padEnd(12))} ${r.fetched} reviews · ${c.green(`${r.added} new`)} · ${r.updated} changed`);
      }
      console.log(c.dim(`\nWrote ${summary.replace(project.root + "/", "")}`));
    });

  reviews
    .command("list")
    .description("Reviews from the repo, newest first")
    .option("--store <store>", "app-store or google-play")
    .option("--rating <n>", "Only this many stars, or 1-2 for a range")
    .option("--unanswered", "Only reviews without a reply", false)
    .option("-n, --limit <n>", "How many", "20")
    .action(async (opts: { store?: StoreId; rating?: string; unanswered: boolean; limit: string }) => {
      const project = await load();
      const [lo, hi] = (opts.rating ?? "1-5").split("-").map(Number);
      const rows = (await readReviews(project.root, opts.store))
        .filter((r) => r.rating >= (lo ?? 1) && r.rating <= (hi ?? lo ?? 5))
        .filter((r) => !opts.unanswered || !r.reply)
        .slice(0, Number(opts.limit) || 20);
      if (g().json) {
        printJson({ reviews: rows });
        return;
      }
      if (rows.length === 0) console.log(c.dim("No reviews. Run appeeky-spec reviews pull."));
      for (const r of rows) {
        const stars = r.rating <= 2 ? c.red(`${r.rating}★`) : r.rating === 3 ? c.yellow(`${r.rating}★`) : c.green(`${r.rating}★`);
        console.log(`${stars} ${c.dim(`${r.date.slice(0, 10)} ${r.store} ${r.where ?? ""} ${r.version ?? ""} ${r.id}`)}${r.reply ? c.dim(" · replied") : ""}`);
        console.log(`   ${(r.title ? `${c.bold(r.title)} ` : "") + r.body.replace(/\s+/g, " ").slice(0, 200)}`);
      }
    });

  reviews
    .command("reply")
    .description("Draft a reply in appeeky/reviews/replies/ for review in a pull request; reviews push sends it")
    .argument("<review>", "Review id from reviews list")
    .requiredOption("--text <text>", "The reply")
    .action(async (id: string, opts: { text: string }) => {
      const project = await load();
      const review = (await readReviews(project.root)).find((r) => r.id === id);
      if (!review) throw new Error(`No review ${id} in appeeky/reviews/. Run appeeky-spec reviews pull first.`);
      const file = await writeReply(project.root, {
        id,
        store: review.store,
        review: `${review.rating}★ ${review.date.slice(0, 10)}: ${(review.title ? `${review.title}. ` : "") + review.body.replace(/\s+/g, " ").slice(0, 200)}`,
        text: opts.text,
      });
      const issues = replyIssues({ id, store: review.store, text: opts.text, status: "draft" });
      if (g().json) {
        printJson({ file, issues });
        return;
      }
      console.log(`${c.green("Drafted")} ${file.replace(project.root + "/", "")}`);
      for (const i of issues) console.log(c.red(`  ${i}`));
    });

  reviews
    .command("push")
    .description("Send the draft replies in appeeky/reviews/replies/ to the stores")
    .option("--yes", "Send without asking", false)
    .action(async (opts: { yes: boolean }) => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: replies are sent through the store connections in Appeeky.");
      const drafts = (await readReplies(project.root)).filter((r) => r.status === "draft");
      const blocked = drafts.filter((r) => replyIssues(r).length);
      if (blocked.length) throw new Error(`Too long: ${blocked.map((r) => `${r.id} (${replyIssues(r).join(", ")})`).join("; ")}`);
      if (drafts.length === 0) {
        if (g().json) printJson({ sent: [] });
        else console.log(c.dim("No draft replies."));
        return;
      }
      if (!g().json) for (const r of drafts) console.log(`${c.bold(r.id)} ${c.dim(r.store)}\n  ${r.text}`);
      if (!opts.yes && !(await confirm(`Send ${drafts.length} repl${drafts.length === 1 ? "y" : "ies"}?`))) return;
      const sent: string[] = [];
      const failed: Array<{ id: string; message: string }> = [];
      for (const r of drafts) {
        try {
          await sendReply(a, r, project.spec.stores.googlePlay?.packageName);
          sent.push(r.id);
        } catch (e) {
          failed.push({ id: r.id, message: (e as Error).message });
        }
      }
      if (g().json) {
        printJson({ sent, failed });
        return;
      }
      console.log(c.green(`Sent ${sent.length}.`));
      for (const f of failed) console.log(`${c.red(f.id)} ${c.dim(f.message)}`);
    });

  const competitors = program.command("competitors").description("Competitors in the repo: their listing, ranks and reviews (needs APPEEKY_API_KEY)");
  competitors
    .command("pull")
    .description("Write each competitor under competitors: to appeeky/competitors/<name>.yaml")
    .action(async () => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: competitor data comes from the Appeeky API.");
      if (project.spec.competitors.length === 0) throw new Error("No competitors in appeeky.spec.yaml. Find some with appeeky-spec competitors discover.");
      const results = await pullCompetitors(a, project.root, project.spec);
      if (g().json) {
        printJson({ results });
        return;
      }
      for (const r of results) {
        console.log(`${r.errors.length ? c.yellow("!") : c.green("✓")} ${r.file.replace(project.root + "/", "")}`);
        for (const e of r.errors) console.log(c.dim(`  ${e}`));
        for (const ch of r.changes) console.log(`  ${c.yellow("changed")} ${ch}`);
      }
      console.log(c.dim("\nThe git diff shows what each competitor changed since the last pull."));
    });

  competitors
    .command("discover")
    .description("Apps like yours, to add as competitors")
    .option("--store <store>", "app-store or google-play")
    .option("--add <n>", "Add the first n to competitors: in appeeky.spec.yaml")
    .action(async (opts: { store?: StoreId; add?: string }) => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: similar apps come from the Appeeky API.");
      const ids = rankAppIds(project);
      const store = opts.store ?? (Object.keys(ids)[0] as StoreId | undefined);
      if (!store || !ids[store]) throw new Error("Set stores.appStore.appId or stores.googlePlay.packageName first.");
      const country = Object.keys(project.spec.targets)[0] ?? "us";
      const apps = await similarApps(a, store, ids[store]!, country);
      const n = Number(opts.add) || 0;
      if (n > 0) {
        const have = new Set(project.spec.competitors.map((x) => (store === "app-store" ? x.appStore : x.googlePlay)));
        const fresh = apps.filter((x) => !have.has(x.id)).slice(0, n);
        project.spec.competitors.push(...fresh.map((x) => (store === "app-store" ? { name: x.title, appStore: x.id } : { name: x.title, googlePlay: x.id })));
        await writeSpec(project.root, project.spec);
      }
      if (g().json) {
        printJson({ store, country, apps, added: n });
        return;
      }
      for (const x of apps) console.log(`${x.id.padEnd(14)} ${x.title}${x.rating ? c.dim(`  ${x.rating}★ ${x.ratings ?? ""}`) : ""}`);
      if (n > 0) console.log(c.green(`\nAdded ${Math.min(n, apps.length)} to appeeky.spec.yaml. Run appeeky-spec competitors pull.`));
      else console.log(c.dim("\nAdd them with --add <n>, or by hand under competitors: in appeeky.spec.yaml."));
    });

  const visibility = program
    .command("visibility")
    .description("Whether ChatGPT, Claude, Gemini and Perplexity name your app, from Appeeky AI Visibility (needs APPEEKY_API_KEY)");
  const needKey = () => {
    const a = api();
    if (!a) throw new Error("Set APPEEKY_API_KEY: AI visibility comes from Appeeky AI Visibility.");
    return a;
  };
  const watched = (project: Project) => {
    const t = visibilityTarget(project);
    if (!t) throw new Error("Set stores.appStore.appId (numeric) or stores.googlePlay.packageName first.");
    return t;
  };
  visibility
    .command("init")
    .description("Write the intents and prompts Appeeky tracks into appeeky.spec.yaml; with none yet, have Appeeky write them from your listing")
    .option("--country <cc>", "Storefront (default: aiVisibility.countries, or the first under targets)")
    .action(async (opts: { country?: string }) => {
      const project = await load();
      const a = needKey();
      const t = watched(project);
      const countries = opts.country ? [opts.country.toLowerCase()] : t.countries;
      const spec = project.spec;
      spec.aiVisibility ??= { intents: {} };
      const report: Array<{ country: string; intents: number; bootstrapped?: boolean }> = [];
      for (const country of countries) {
        const remote = await readRemoteIntents(a, t.appId, country);
        if (remote.length > 0) {
          spec.aiVisibility.intents[country] = remote;
          report.push({ country, intents: remote.length });
        } else {
          const r = await bootstrapIntents(a, t.appId, country, languageFor(project, country));
          report.push({ country, intents: 0, bootstrapped: r.queued || r.already });
        }
      }
      // A storefront asked for by --country is watched from now on.
      if (opts.country && !t.countries.includes(countries[0]!)) spec.aiVisibility.countries = [...t.countries, countries[0]!];
      if (report.some((r) => r.intents > 0)) await writeSpec(project.root, spec);
      if (g().json) {
        printJson({ store: t.store, appId: t.appId, report });
        return;
      }
      for (const r of report) {
        if (r.intents > 0) console.log(`${c.green("✓")} ${r.country.toUpperCase()}: wrote ${r.intents} intents to aiVisibility.intents in appeeky.spec.yaml`);
        else console.log(`${c.yellow("…")} ${r.country.toUpperCase()}: Appeeky is writing intents and prompts from your listing. Run appeeky-spec visibility init again in a few minutes.`);
      }
      if (report.some((r) => r.intents > 0)) console.log(c.dim("\nEdit them in the spec, then send the changes with appeeky-spec visibility sync."));
    });

  visibility
    .command("sync")
    .description("Send the intents and prompts in appeeky.spec.yaml to Appeeky AI Visibility")
    .option("--prune", "Also archive intents and prompts that are not in the spec", false)
    .option("--dry-run", "Only show what would change", false)
    .action(async (opts: { prune: boolean; dryRun: boolean }) => {
      const project = await load();
      const a = needKey();
      const t = watched(project);
      const intents = project.spec.aiVisibility?.intents ?? {};
      if (Object.keys(intents).length === 0) throw new Error("No aiVisibility.intents in appeeky.spec.yaml. Start with appeeky-spec visibility init.");
      const out = [];
      for (const [country, wanted] of Object.entries(intents)) {
        const plan = await planSync(a, t.appId, country, wanted);
        const applied = opts.dryRun ? null : await applySync(a, t.appId, plan, languageFor(project, country), opts.prune);
        out.push({ plan, applied });
      }
      if (g().json) {
        printJson(out);
        return;
      }
      for (const { plan, applied } of out) {
        const cc = plan.country.toUpperCase();
        for (const i of plan.addIntents) console.log(`${c.green("+")} ${cc} intent "${i.label}" (${i.prompts.length} prompts)`);
        for (const p of plan.addPrompts) console.log(`${c.green("+")} ${cc} prompt under "${p.label}": ${p.text}`);
        const drop = opts.prune ? c.red("-") : c.dim("·");
        for (const i of plan.extraIntents) console.log(`${drop} ${cc} intent "${i.label}"${opts.prune ? "" : c.dim(" (only in Appeeky; --prune archives it)")}`);
        for (const p of plan.extraPrompts) console.log(`${drop} ${cc} prompt under "${p.label}": ${p.text}${opts.prune ? "" : c.dim(" (only in Appeeky)")}`);
        const nothing = !plan.addIntents.length && !plan.addPrompts.length && !plan.extraIntents.length && !plan.extraPrompts.length;
        if (nothing) console.log(c.dim(`${cc}: in sync.`));
        else if (applied) console.log(c.dim(`${cc}: added ${applied.intents} intents and ${applied.prompts} prompts${opts.prune ? `, archived ${applied.archived}` : ""}.`));
      }
      if (opts.dryRun) console.log(c.dim("\nDry run: nothing was sent."));
      else console.log(c.dim("\nThe next scheduled scan asks the assistants. To ask now: appeeky-spec visibility scan (uses AI Visibility credits)."));
    });

  visibility
    .command("pull")
    .description("Write what the assistants answer to appeeky/visibility/<country>.yaml")
    .option("--country <cc>", "One storefront only")
    .action(async (opts: { country?: string }) => {
      const project = await load();
      const a = needKey();
      const results = await pullVisibility(a, project, opts.country ? [opts.country.toLowerCase()] : undefined);
      if (g().json) {
        printJson(results.map(({ data, ...r }) => ({ ...r, summary: data?.summary })));
        return;
      }
      for (const r of results) {
        const cc = r.country.toUpperCase();
        if (r.error) {
          console.log(`${c.red("✗")} ${cc}: ${r.error}`);
          continue;
        }
        const d = r.data!;
        if (d.intents.length === 0) {
          console.log(`${c.yellow("!")} ${cc}: no intents tracked yet. Start with appeeky-spec visibility init.`);
          continue;
        }
        const s = d.summary;
        console.log(`${c.green("✓")} ${r.file!.replace(project.root + "/", "")}  ${c.green(`${s.winning} named`)} · ${c.yellow(`${s.weak} weak`)} · ${c.red(`${s.missing} missing`)}${s.noData ? c.dim(` · ${s.noData} not scanned yet`) : ""}`);
        for (const i of d.intents.filter((x) => x.status === "missing").slice(0, 3)) console.log(`  ${c.red("missing")} "${i.label}"${i.namedInstead ? c.dim(`: they name ${i.namedInstead.slice(0, 3).join(", ")}`) : ""}`);
        for (const ch of r.changes) console.log(`  ${c.yellow("changed")} ${ch}`);
        if (d.fixes.length) console.log(c.dim(`  ${d.fixes.length} suggested fixes in the file.`));
      }
    });

  visibility
    .command("scan")
    .description("Ask the assistants now instead of waiting for the schedule (uses AI Visibility credits)")
    .option("--country <cc>", "One storefront only")
    .action(async (opts: { country?: string }) => {
      const project = await load();
      const a = needKey();
      const t = watched(project);
      const countries = opts.country ? [opts.country.toLowerCase()] : t.countries;
      for (const country of countries) await scanVisibility(a, t.appId, country);
      if (g().json) {
        printJson({ scanned: countries });
        return;
      }
      console.log(c.green(`Scan started for ${countries.map((x) => x.toUpperCase()).join(", ")}.`) + c.dim(" Pull the results in a few minutes: appeeky-spec visibility pull"));
    });

  const category = program.command("category").description("Your rank in the category chart, one row a day in appeeky/category.csv");
  category
    .command("pull")
    .description("Record today's category rank (App Store: no key needed; Google Play: APPEEKY_API_KEY)")
    .action(async () => {
      const project = await load();
      const { plans, notes } = await categoryPlans(project);
      const a = api();
      if (!a && plans.some((p) => p.store === "google-play")) notes.push("Google Play: set APPEEKY_API_KEY to read its chart.");
      const history = await readCategoryHistory(project.root);
      const { ranks, failed } = await readCategoryRanks(plans, chartSources(a));
      const file = ranks.length ? await saveCategoryRanks(project.root, ranks) : undefined;
      if (g().json) {
        printJson({ plans, ranks, failed, notes, file });
        return;
      }
      for (const r of ranks) {
        const prev = previousRank(history, r);
        const now = r.rank === null ? "not in the top 100" : `#${r.rank}`;
        let move = "";
        if (prev) {
          const d = (prev.rank ?? 101) - (r.rank ?? 101);
          move = d > 0 ? c.green(` ▲${d}`) : d < 0 ? c.red(` ▼${-d}`) : c.dim(" =");
          move += c.dim(` since ${prev.date}`);
        }
        console.log(`${storeLabel(r.store).padEnd(12)} ${r.country.toUpperCase()}  ${r.chart} · ${r.name ?? r.category}  ${c.bold(now)}${move}`);
      }
      for (const f of failed) console.log(c.yellow(`! ${f}`));
      for (const n of notes) console.log(c.dim(n));
      if (file) console.log(c.dim(`\nRecorded in ${categoryFile(project.root).replace(project.root + "/", "")}. verify reads it as category_rank.`));
    });

  const attribution = program.command("attribution").description("Install attribution from Appeeky Analytics");
  attribution
    .command("init")
    .description("Create the app in Appeeky Analytics for each store, write attribution: and print the SDK key")
    .option("--self [url]", "Your own Appeeky Analytics server (with ATTRIBUTION_TOKEN); without it, Appeeky's hosted service (with APPEEKY_API_KEY)")
    .action(async (opts: { self?: string | boolean }) => {
      const project = await load();
      const via: "self" | "hosted" = opts.self ? "self" : "hosted";
      const url = typeof opts.self === "string" ? opts.self : project.spec.attribution?.url;
      if (specStores(project.spec).length === 0) throw new Error("Add the App Store app id or the Google Play package under stores: first.");
      let apps;
      if (via === "self") {
        if (!url) throw new Error("--self <url>: your Appeeky Analytics server, e.g. https://analytics.example.workers.dev");
        if (!process.env.ATTRIBUTION_TOKEN) throw new Error("Set ATTRIBUTION_TOKEN to your server's ADMIN_TOKEN.");
        apps = await initSelfHosted(project.spec, url, process.env.ATTRIBUTION_TOKEN);
      } else {
        const a = api();
        if (!a) throw new Error("Set APPEEKY_API_KEY to turn attribution on in Appeeky.");
        apps = await initHosted(project.spec, a);
      }
      project.spec.attribution = attributionBlock(via, apps, url);
      await writeSpec(project.root, project.spec);
      if (g().json) {
        printJson({ apps, attribution: project.spec.attribution });
        return;
      }
      for (const a of apps) console.log(`${c.green(a.created ? "Created" : "Found")} ${storeLabel(a.store)} app ${c.bold(a.id)} · key ${a.publishableKey}`);
      console.log(c.dim("Wrote attribution: to appeeky.spec.yaml.\n"));
      for (const line of nextSteps(via, apps, url)) console.log(line);
    });

  const data = program.command("data").description("Your app's analytics, ads and revenue as CSV files an agent can read (needs APPEEKY_API_KEY)");
  data
    .command("pull")
    .description("App Store Connect, Google Play, Apple Search Ads, RevenueCat, Meta and TikTok, per day")
    .option("--days <n>", "How many days, up to yesterday", "90")
    .action(async (opts: { days: string }) => {
      const project = await load();
      const a = api();
      const attribution = attributionClients(project.spec, a);
      if (!a && !hasClients(attribution)) throw new Error("Set APPEEKY_API_KEY (data from the connections in Appeeky), or attribution: with via: self and ATTRIBUTION_TOKEN.");
      const result = await pullData(a, project, Number(opts.days) || 90, new Date(), hasClients(attribution) ? attribution : undefined);
      if (g().json) {
        printJson(result);
        return;
      }
      for (const f of result.files) console.log(`${c.green("✓")} ${f.path.replace(project.root + "/", "").padEnd(52)} ${String(f.rows).padStart(5)} rows ${c.dim(f.from && f.to ? `${f.from} → ${f.to}` : "")}`);
      for (const e of result.errors) console.log(`${c.red("✗")} ${e.source.padEnd(42)} ${c.dim(e.message)}`);
      if (result.files.length === 0 && result.errors.length === 0) console.log(c.dim("Nothing to pull. Connect your stores, Search Ads or RevenueCat in Appeeky."));
      if (!project.spec.data.commit && result.files.length) console.log(c.dim("\nIn .appeeky/data/ (gitignored). Set data: { commit: true } in appeeky.spec.yaml to version it with the spec."));
    });

  program
    .command("revert")
    .description("Put the values from before a release back into the spec (then run push)")
    .argument("<release>", "Release id from `appeeky-spec log`")
    .action(async (id: string) => {
      const project = await load();
      const release = (await readReleases(project.root)).find((r) => r.id === id || r.id.startsWith(id));
      if (!release) throw new Error(`No release ${id}. See \`appeeky-spec log\`.`);
      const inverse = invertChanges(release.changes.map((ch) => ({ ...ch, store: release.store, newLocale: false })));
      const touched = new Set<string>();
      for (const ch of inverse) {
        const listings = project.listings[release.store] as Record<string, Record<string, string>>;
        listings[ch.locale] = { ...listings[ch.locale], [ch.field]: ch.after };
        touched.add(ch.locale);
      }
      for (const locale of touched) {
        await writeListing(project.root, release.store, locale, (project.listings[release.store] as Record<string, Listing>)[locale]!);
      }
      if (g().json) printJson({ release: release.id, reverted: inverse.length });
      else {
        console.log(`${c.green("Restored")} ${inverse.length} fields from before ${release.id} in the spec. Review with \`appeeky-spec diff\`, then \`appeeky-spec push\`.`);
      }
    });

  program
    .command("suggest")
    .description("Words to add to an App Store keyword field, from missing targets and Appeeky keyword opportunities")
    .option("--locale <locale>", "Listing locale (default: the primary locale)")
    .option("--country <cc>", "Storefront for opportunities", "us")
    .option("--apply <words...>", "Add these words to the keyword field in the spec")
    .action(async (opts: { locale?: string; country: string; apply?: string[] }) => {
      const project = await load();
      const locale = opts.locale ?? project.spec.app.primaryLocale;
      if (!project.listings["app-store"][locale]) throw new Error(`No App Store listing for ${locale}. Run \`appeeky-spec pull\` first.`);
      if (opts.apply) {
        let field = project.listings["app-store"][locale]!.keywords ?? "";
        const skipped: string[] = [];
        for (const w of opts.apply) {
          const next = appendKeyword(field, w);
          if (next === null) skipped.push(w);
          else field = next;
        }
        await writeListing(project.root, "app-store", locale, { ...project.listings["app-store"][locale], keywords: field });
        if (g().json) printJson({ locale, keywords: field, skipped });
        else console.log(`${c.green("Updated")} ${locale} keywords → ${field}${skipped.length ? c.yellow(`\nDid not fit: ${skipped.join(", ")}`) : ""}`);
        return;
      }
      const a = api();
      const appId = rankAppIds(project)["app-store"];
      const candidates = a && appId ? await a.opportunities(appId, opts.country.toLowerCase(), "app-store").catch(() => []) : [];
      const suggestions = keywordSuggestions(project, locale, candidates);
      if (g().json) {
        printJson({ locale, suggestions });
        return;
      }
      if (suggestions.length === 0) console.log(c.dim("Nothing to add: every target word is already indexed."));
      for (const s of suggestions.slice(0, 25)) {
        const pop = s.popularity !== undefined ? c.dim(` pop ${s.popularity}`) : "";
        console.log(`${s.fits ? c.green("+") : c.dim("·")} ${s.word.padEnd(18)}${pop}  ${c.dim(`helps: ${s.helps.slice(0, 3).join(", ")}`)}${s.fits ? "" : c.dim(" (does not fit)")}`);
      }
      if (!a) console.log(c.dim("\nSet APPEEKY_API_KEY to add Appeeky keyword opportunities."));
      else console.log(c.dim(`\nAdd with: appeeky-spec suggest --locale ${locale} --apply <words...>`));
    });

  program
    .command("verify")
    .description("Measure releases against the ranks recorded before each push (day 7 and day 14)")
    .argument("[releases...]", "Release ids (default: every release that reached a milestone)")
    .option("--now", "Measure now, even before day 7", false)
    .option("--playbook", "Add one line per result to appeeky/playbook.md", false)
    .action(async (ids: string[], opts: { now: boolean; playbook: boolean }) => {
      const project = await load();
      const a = api();
      const attribution = attributionClients(project.spec, a);
      const visibility = a ? visibilityMetricSource(a, project) : null;
      const metrics = combineSources([
        ...(a ? [metricSourceFor(a, project.spec)] : []),
        ...(visibility ? [visibility] : []),
        categoryMetricSource(project.root),
        reviewMetricSource(project.root),
        ...(hasClients(attribution) ? [attributionMetricSource(attribution)] : []),
      ]);
      const results = await verifyReleases(project, rankSource(), { ids: ids.length ? ids : undefined, force: opts.now, metrics });
      const measured = metrics ? await measureExperiments(project, metrics) : [];
      const lines = [...results.map(playbookLine), ...measured.map(experimentPlaybookLine)];
      const added = opts.playbook ? await appendPlaybook(project.root, lines) : 0;
      const experiments = dueExperiments(await readExperiments(project.root));
      await writeLoops(project.root);
      if (g().json) {
        printJson({
          results: results.map((r) => ({ release: r.release.id, ...r.check })),
          closedExperiments: measured,
          playbookLines: added,
          dueExperiments: experiments.map((e) => e.id),
        });
        return;
      }
      if (results.length === 0) console.log(c.dim("No release is due. Releases are measured on day 7 and day 14 (or pass --now)."));
      for (const { release, check } of results) {
        const tone = check.verdict === "won" ? c.green : check.verdict === "lost" ? c.red : c.yellow;
        const by = check.decidedBy ? c.dim(` (ranks did not move; decided by ${check.decidedBy.map((m) => METRICS[m as MetricName]?.label ?? m).join(", ")})`) : "";
        console.log(`${c.bold(release.id)}  day ${check.day}: ${tone(check.verdict)}${by}  ${check.improved.length} up · ${check.dropped.length} down · ${check.regressions.length} top-20 lost`);
        if (check.control) {
          const k = check.control;
          const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
          console.log(`  ${c.dim("control")} changed (${k.changed.join(", ")}) ${sign(k.changedMove)} places · unchanged (${k.control.join(", ")}) ${sign(k.controlMove)} · net ${sign(k.net)}`);
        }
        if (check.note) console.log(`  ${c.yellow(check.note)}`);
        for (const m of check.regressions) console.log(`  ${c.red("lost")} ${m.country.toUpperCase()} "${m.keyword}" ${m.before} → ${m.after ?? "not ranked"}`);
        for (const m of check.improved.slice(0, 5)) console.log(`  ${c.green("up")}   ${m.country.toUpperCase()} "${m.keyword}" ${m.before ?? "not ranked"} → ${m.after}`);
        for (const m of check.metrics?.changes ?? []) {
          const tone = m.outcome === "better" ? c.green : m.outcome === "worse" ? c.red : c.dim;
          const usual = m.noise !== undefined && m.noise > 0.05 ? c.dim(`  (moves ±${Math.round(m.noise * 100)}% on its own)`) : "";
          console.log(`  ${tone(m.outcome.padEnd(6))} ${formatChange(m, check.metrics?.after.currency)}${usual}`);
        }
        if (check.verdict === "lost") console.log(c.yellow(`  Consider: appeeky-spec revert ${release.id}`));
      }
      for (const e of measured) {
        const tone = e.status === "won" ? c.green : e.status === "lost" ? c.red : c.yellow;
        console.log(`${c.bold(e.id)}: ${tone(e.status)}  ${e.metric} ${e.baseline !== undefined ? `${round(e.baseline)} → ` : ""}${round(e.result?.value)}`);
      }
      if (!a && results.length > 0) console.log(c.dim("\nSet APPEEKY_API_KEY to measure conversion, downloads, revenue and ads too."));
      if (added > 0) console.log(c.dim(`\nAdded ${added} line${added === 1 ? "" : "s"} to appeeky/playbook.md.`));
      for (const e of experiments) console.log(c.yellow(`Experiment ${e.id} is due: appeeky-spec experiment close ${e.id} --value <${e.metric}>`));
    });

  const experiment = program.command("experiment").description("Growth experiments outside the listing: screenshots, UGC, ads, pricing");
  experiment
    .command("add")
    .description("Start an experiment")
    .requiredOption("--hypothesis <text>", "What you expect and why")
    .requiredOption("--metric <name>", `The one number that decides it. Measured for you: ${Object.keys(METRICS).join(", ")}`)
    .option("--type <type>", "screenshots | ugc | ads | pricing | other", "other")
    .option("--persona <id>", "Persona id from appeeky.spec.yaml")
    .option("--store <store>", "app-store | google-play")
    .option("--country <cc>", "Storefront")
    .option("--baseline <n>", "Metric value before", parseFloat)
    .option("--target <n>", "Metric value that counts as a win", parseFloat)
    .option("--days <n>", "Check after this many days", "14")
    .option("--asset <paths...>", "Files, links or ad ids that ran")
    .option("--link [channel]", "Create a smart link for the experiment (needs attribution:); optional channel: tiktok, instagram, creator, tiktok_ads, meta_ads…")
    .action(async (o: { hypothesis: string; metric: string; type: string; persona?: string; store?: string; country?: string; baseline?: number; target?: number; days: string; asset?: string[]; link?: string | boolean }) => {
      const project = await load();
      if (o.persona && !project.spec.personas.some((p) => p.id === o.persona)) throw new Error(`No persona "${o.persona}" in ${SPEC_FILE}.`);
      const now = new Date();
      const days = Number(o.days) || 14;
      let baseline = o.baseline;
      const a = api();
      if (baseline === undefined && a && isMetricName(o.metric)) {
        // The baseline is the metric over the same number of days before the start.
        const app = experimentApp(project, { store: o.store as StoreId | undefined });
        if (app) baseline = await metricBefore(metricSourceFor(a, project.spec), app.store, app.appId, o.metric, now.toISOString(), days).catch(() => undefined);
      }
      const id = experimentId(now, o.hypothesis)
      let link: { slug: string; url?: string; store?: StoreId } | undefined;
      if (o.link) {
        const client = attributionClient(project.spec, a);
        if (!isClient(client)) throw new Error(`--link needs attribution. ${client.missing}`);
        const made = await createExperimentLink(
          client,
          id,
          { appStoreId: project.spec.stores.appStore?.appId, packageName: project.spec.stores.googlePlay?.packageName },
          typeof o.link === "string" ? o.link : undefined,
        );
        const host = project.spec.attribution?.via === "self" ? project.spec.attribution.url?.replace(/\/$/, "") : "https://ingest.appeeky.com";
        link = { slug: made.slug, url: `${host}/l/${made.slug}`, store: linkStore(project.spec) };
        if (o.baseline === undefined && o.metric.startsWith("link_")) baseline = 0;
      }
      const e = await writeExperiment(project.root, {
        ...(link ? { link } : {}),
        id,
        type: o.type as "other",
        hypothesis: o.hypothesis,
        persona: o.persona,
        store: o.store as StoreId | undefined,
        country: o.country,
        metric: o.metric,
        baseline,
        target: o.target,
        startedAt: now.toISOString(),
        checkAfterDays: days,
        assets: o.asset ?? [],
      });
      await writeLoops(project.root);
      if (g().json) printJson({ experiment: e });
      else {
        console.log(`${c.green("Started")} ${e.id} · check on ${new Date(now.getTime() + e.checkAfterDays * 86_400_000).toISOString().slice(0, 10)}`);
        if (e.baseline !== undefined) console.log(c.dim(`  baseline ${e.metric} ${round(e.baseline)}${o.baseline === undefined ? " (last " + days + " days)" : ""}`));
        else if (isMetricName(e.metric) && !a) console.log(c.dim("  Set APPEEKY_API_KEY to measure the baseline and the result for you."));
        if (e.link?.url) console.log(`  ${c.bold("link")} ${e.link.url} ${c.dim("· post this link; its installs and revenue are counted to it")}`);
        if (e.link && iosOnlyLink(project.spec, e.metric)) console.log(c.yellow(IOS_LINK_NOTE));
      }
    });
  experiment
    .command("list")
    .description("Experiments, newest first")
    .action(async () => {
      const project = await load();
      const all = await readExperiments(project.root);
      const due = new Set(dueExperiments(all).map((e) => e.id));
      if (g().json) {
        printJson({ experiments: all.map((e) => ({ ...e, due: due.has(e.id) })) });
        return;
      }
      if (all.length === 0) console.log(c.dim("No experiments yet."));
      for (const e of all) {
        const status = due.has(e.id) ? c.yellow("due") : e.status === "won" ? c.green("won") : e.status === "lost" ? c.red("lost") : c.dim(e.status);
        console.log(`${c.bold(e.id)}  ${e.type} · ${status}${e.result?.value !== undefined ? ` · ${e.metric} ${e.result.value}` : ""}\n  ${c.dim(e.hypothesis)}`);
      }
    });
  experiment
    .command("close")
    .description("Record the result of an experiment")
    .argument("<id>")
    .option("--value <n>", "Measured metric value", parseFloat)
    .option("--note <text>", "What happened")
    .option("--playbook", "Add the result to appeeky/playbook.md", false)
    .action(async (id: string, o: { value?: number; note?: string; playbook: boolean }) => {
      const project = await load();
      const e = (await readExperiments(project.root)).find((x) => x.id === id || x.id.startsWith(id));
      if (!e) throw new Error(`No experiment ${id}. See \`appeeky-spec experiment list\`.`);
      let value = o.value;
      const a = api();
      if (value === undefined && e.link && (e.metric === "link_clicks" || e.metric === "link_installs" || e.metric === "link_revenue")) {
        // The experiment's own smart link: its clicks, or the installs and revenue counted to it.
        const client = attributionClient(project.spec, a, process.env, e.link.store);
        const stats = isClient(client) ? await linkResult(client, e.link.slug).catch(() => null) : null;
        if (stats) value = e.metric === "link_clicks" ? stats.clicks.total : e.metric === "link_installs" ? stats.installs : stats.revenueUsd;
      }
      if (value === undefined && a && isMetricName(e.metric)) {
        const app = experimentApp(project, e);
        if (app) value = await metricAfter(metricSourceFor(a, project.spec), app.store, app.appId, e.metric, e.startedAt, e.checkAfterDays).catch(() => undefined);
      }
      const closed = await writeExperiment(project.root, closeExperiment(e, value, o.note));
      if (o.playbook) await appendPlaybook(project.root, [experimentPlaybookLine(closed)]);
      await writeLoops(project.root);
      if (g().json) printJson({ experiment: closed });
      else console.log(`${closed.id}: ${closed.status}`);
    });

  const screenshots = program.command("screenshots").description("App Store screenshots in appeeky/screenshots/");
  screenshots
    .command("pull")
    .description("Download the live screenshots of every locale")
    .option("--locale <locales...>", "Only these locales")
    .action(async (opts: { locale?: string[] }) => {
      const project = await load();
      const handle = storeHandle(project, "app-store", transportOverrides());
      const state = await handle.adapter.pull();
      const count = await pullScreenshots(project.root, handle.transport, state, { locales: opts.locale });
      if (g().json) printJson({ downloaded: count });
      else console.log(`${c.green("Downloaded")} ${count} screenshots from ${state.target}`);
    });
  screenshots
    .command("check")
    .description("Sizes and counts per display type")
    .action(async () => {
      const project = await load();
      const issues = await checkScreenshots(project.root);
      if (g().json) printJson({ issues });
      else console.log(formatIssues(issues));
      if (hasErrors(issues)) process.exitCode = 1;
    });

  program
    .command("report")
    .description("Markdown for a pull request: listing changes, check results and coverage against a base ref")
    .option("--base <ref>", "Git ref to compare with", "origin/main")
    .option("-o, --output <file>", "Write the report to a file")
    .action(async (opts: { base: string; output?: string }) => {
      const project = await load();
      const base = await loadProjectAtRef(project.root, opts.base);
      const md = specReport(base, project);
      if (opts.output) await writeFile(opts.output, `${md}\n`);
      else console.log(md);
      if (hasErrors(lintProject(project))) process.exitCode = 1;
    });

  return program;
}

export async function run(argv = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const message = (err as Error).message;
    if (program.opts<GlobalOpts>().json) printJson({ error: message });
    else console.error(c.red(message));
    process.exitCode = 1;
  }
}

const STATE_TONE = { late: c.red, due: c.yellow, measuring: c.dim, closed: c.dim } as const;

function printLoop(l: Loop): void {
  const state = STATE_TONE[l.state](l.state.padEnd(9));
  const when = l.nextCheck ? `next ${l.nextCheck}` : "";
  console.log(`${state} ${c.bold(l.id)}  ${c.dim(`${l.kind}${l.store ? ` · ${l.store}` : ""}${when ? ` · ${when}` : ""}`)}`);
  console.log(`          ${l.what}`);
  console.log(`          ${c.dim("decided by")} ${l.metric}${l.result ? `  ${c.dim("·")} ${l.result}` : ""}`);
  for (const d of l.detail ?? []) console.log(`          ${c.dim(d)}`);
  for (const w of l.warnings) console.log(`          ${c.yellow("! " + w)}`);
}

