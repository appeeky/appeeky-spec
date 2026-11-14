import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import * as p from "@clack/prompts";
import { Command, Option } from "commander";
import { adsSnapshot, CHANNEL_LABELS, saveAdsSnapshot } from "./ads.js";
import { COFOUNDER_COMMAND, installAgents, parseTargets, TARGET_DIRS, type InstalledFile } from "./agents.js";
import { attributionClient, attributionClients, attributionMetricSource, createExperimentLink, hasClients, IOS_LINK_NOTE, iosOnlyLink, isClient, linkStore, linkValueReader } from "./attribution.js";
import { pullCompetitors, similarApps } from "./competitors.js";
import { commentPlatform, deleteComment, draftIssues, fetchSocial, hideComment, likeComment, listComments, readAccounts, readDrafts, replyToComment, resolveAccounts, saveSocial, sendDraft } from "./social.js";
import { fetchUgc, findPersona, generateBrief, quoteBrief, readBriefs, readPersonas, saveUgc } from "./ugc.js";
import { generateLocal, loadCore, planLocalClip, readAppeekyPersona, readLocalPersona, type LocalPersona } from "./ugc-local.js";
import { categoryFile, categoryMetricSource, categoryPlans, chartSources, previousRank, readCategoryHistory, readCategoryRanks, saveCategoryRanks } from "./category.js";
import { applySync, bootstrapIntents, languageFor, planSync, pullVisibility, readRemoteIntents, scanVisibility, visibilityMetricSource, visibilityTarget } from "./visibility.js";
import { appContext, daysSinceLocalScan, KEY_NAMES, type LocalScanPlan, loadVisibilityCore, localVisibilityMetricSource, planLocalScan, scanLocal } from "./visibility-local.js";
import { pullSearchAds, SearchAdsClient, searchAdsMetricSource, searchAdsSource } from "./search-ads.js";
import { daysSinceRanks, pullDomain, pullKeywords, pullRanks, quoteSeo, readDataForSeo, webKeywords, webRankMetricSource } from "./dataforseo.js";
import { checkSite, llmsTxt, pullSearchConsole, readServiceAccount, searchConsoleProperty, seoMetricSource, type SiteCheck } from "./seo.js";
import { attributionBlock, initHosted, initSelfHosted, nextSteps, specStores } from "./attribution-setup.js";
import { pullData } from "./data.js";
import { combineSources } from "./metrics.js";
import { fetchReviews, readReplies, readReviews, replyIssues, reviewMetricSource, saveReviews, sendReply, writeReply, writeSummary } from "./reviews.js";
import { AppeekyApi, appeekyRankSource, loadPopularity, metricSourceFor } from "./appeeky-api.js";
import { closeExperiment, dueExperiments, experimentId, readExperiments, writeExperiment, type Experiment } from "./experiments.js";
import { appendPlaybook, experimentApp, measureExperiments, playbookLine, verifyReleases } from "./measure.js";
import { formatChange, isMetricName, METRICS, metricAfter, metricBefore, type MetricName } from "./metrics.js";
import { loadProjectAtRef, outboxReport, specReport } from "./report.js";
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
import { c, formatChanges, formatCoverage, formatIssues, printJson, spin, storeLabel } from "./output.js";
import { CODING_AGENTS, onPath, runQuiet, setupPrompt, type CodingAgent } from "./coding-agents.js";
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

/** End the setup cleanly on Ctrl+C or Esc. */
function need<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Setup stopped. Run it again any time.");
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

/** A text prompt; Enter gives `defaultValue` when there is one. */
async function textQ(message: string, opts: { placeholder?: string; defaultValue?: string; validate?: (v: string | undefined) => string | undefined } = {}): Promise<string> {
  return (need(await p.text({ message, ...opts })) ?? "").trim();
}

/** Run something that logs, keeping its lines to show them once it is done. */
async function captured(task: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await task();
  } finally {
    console.log = log;
  }
  return lines;
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
   * The guided setup: find the app, make its folder and write the spec, check that the stores
   * can be reached and pull, suggest targets from what it already ranks for, show coverage, then
   * install the skills for the user's coding agent and hand the rest over to it.
   */
  async function wizard(cwd: string, locale: string, country: string) {
    p.intro(c.badge(" Appeeky Spec "));

    // 1. The app
    const term = await textQ("What is your app called on the App Store?", { validate: (v) => (v?.trim() ? undefined : "Type the app's name") });
    const s = p.spinner();
    s.start("Searching the App Store");
    const found = await findApps(term, country).catch(() => []);
    s.stop(found.length ? `Found ${found.length} ${found.length === 1 ? "app" : "apps"}` : "Not on the App Store in this country");
    let appStore: string | undefined;
    let name = term;
    let storeName = term;
    let bundleId = "";
    if (found.length) {
      const pick = need(
        await p.select({
          message: "Which one is yours?",
          options: [
            ...found.map((app) => ({ value: app.id, label: app.name, hint: `${app.developer}${app.rating ? ` · ${app.rating}★` : ""} · ${app.id}` })),
            { value: "", label: "None of these" },
          ],
        }),
      );
      const app = found.find((a) => a.id === pick);
      if (app) {
        appStore = app.id;
        name = app.name.split(/[:\-–—|]/)[0]!.trim() || app.name;
        storeName = app.name;
        bundleId = app.bundleId;
      }
    }
    if (!appStore) {
      const id = await textQ("App Store id (digits)", { placeholder: "Enter to skip", defaultValue: "", validate: (v) => (!v || /^\d{5,}$/.test(v.trim()) ? undefined : "Digits only, like 6763859497") });
      if (id) appStore = id.trim();
    }
    let googlePlay: string | undefined;
    if (need(await p.confirm({ message: "Is it on Google Play too?", initialValue: false }))) {
      const pkg = await textQ("Google Play package", { placeholder: bundleId || "com.example.app", defaultValue: bundleId, validate: (v) => (v?.trim() || bundleId ? undefined : "Type the package name") });
      s.start("Checking Google Play");
      const live = await playPackageExists(pkg);
      s.stop(live ? `${pkg} is on Google Play` : c.yellow(`No public Google Play page for ${pkg}: kept, check the name`));
      googlePlay = pkg;
    }
    if (!appStore && !googlePlay) {
      p.cancel("Give an App Store id or a Google Play package to set up the spec.");
      process.exitCode = 1;
      return;
    }

    // 2. The folder and the spec. Inside an app's repo the spec goes next to the code; anywhere else it gets a folder of its own.
    const inProject = [".git", "package.json", "app.json", "pubspec.yaml"].some((f) => existsSync(join(cwd, f)));
    const suggested = inProject ? "." : `./${slug(name)}`;
    const folder = await textQ("Where should the spec live?", { placeholder: suggested, defaultValue: suggested });
    const root = resolve(cwd, folder);
    const cdHint = folder === "." ? "" : `cd ${folder.replace(/^\.\//, "")}`;
    if (existsSync(join(root, SPEC_FILE))) {
      p.cancel(`${SPEC_FILE} already exists in ${root}. Run \`appeeky-spec doctor\` there to see what is set up.`);
      process.exitCode = 1;
      return;
    }
    // Subcommands parse the global options again, so each one is told the folder.
    const sub = (args: string[]) => program.parseAsync(["-C", root, ...args], { from: "user" });
    await mkdir(root, { recursive: true });
    program.setOptionValue("cwd", root);
    const created: string[] = [];
    if (!existsSync(join(root, ".git")) && !inProject && (await runQuiet("git", ["init", "-q"], root)).code === 0) created.push("a new git repo");
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
    created.push(SPEC_FILE, `${SPEC_DIR}/playbook.md`);
    if (await ignoreLocalData(root)) created.push(".appeeky/ in .gitignore");
    p.log.success(`${c.bold(folder)}  ${c.dim(created.join(", "))}`);
    if (existsSync(join(root, ".git")) && need(await p.confirm({ message: "Add GitHub Actions? (pull request check, push on merge, daily verify)" }))) {
      const written = await writeWorkflows(root);
      p.log.success(`${written.join(", ")}\n${c.dim("The push and the daily run need APPEEKY_API_KEY (or your store keys) as repository secrets.")}`);
    }

    // 3. Store access and the live listing
    let project = await load();
    const reachOf = () => diagnose(root, project).filter((x) => x.area === "App Store" || x.area === "Google Play");
    let reach = reachOf();
    logChecks(reach);
    // A store that cannot be reached: offer to save the user's own key with the store CLI, once per machine.
    let saved = false;
    for (const x of reach.filter((r) => r.status === "fail")) {
      const store: StoreId = x.area === "App Store" ? "app-store" : "google-play";
      if (!need(await p.confirm({ message: `Save your ${x.area} key on this machine now?`, initialValue: true }))) continue;
      saved = (await saveStoreKey(store, slug(name), store === "app-store" ? appStore : googlePlay)) || saved;
    }
    if (saved) {
      reach = reachOf();
      logChecks(reach);
    }
    let pulled = false;
    // Pull each store that can be reached, one at a time: one store's problem does not stop the other.
    const reachable = reach.filter((x) => x.status === "ok").map((x) => (x.area === "App Store" ? "app-store" : "google-play") as StoreId);
    if (reachable.length && need(await p.confirm({ message: `Pull your live listing from ${reachable.map(storeLabel).join(" and ")} now?` }))) {
      for (const store of reachable) {
        s.start(`Pulling your ${storeLabel(store)} listing`);
        try {
          const lines = await captured(() => sub(["pull", "--store", store]));
          s.stop(`Pulled your ${storeLabel(store)} listing`);
          if (lines.length) p.log.message(lines.join("\n"));
          pulled = true;
        } catch (e) {
          s.error(`${storeLabel(store)}: ${(e as Error).message}`);
        }
      }
    }
    if (reachable.length < reach.length) p.log.info(c.dim("Your agent can walk you through store access at the end."));

    // 4. Targets
    project = await load();
    // Without a pulled listing, the App Store name still says what the app is for.
    const candidates = targetCandidates(project, 14, storeName);
    s.start(`Checking where ${name} ranks for ${candidates.length} ${candidates.length === 1 ? "search" : "searches"} in ${country.toUpperCase()}`);
    const ranked = await suggestTargets(candidates, appStore, country, itunesRankSource()).catch(() => []);
    s.stop(ranked.length ? `Searches to win in ${country.toUpperCase()}` : "No ranked searches found yet");
    let targets: string[] = [];
    if (ranked.length) {
      const picked = need(
        await p.multiselect({
          message: "Which searches should the listing win?",
          options: ranked.map((r) => ({ value: r.keyword, label: r.keyword, hint: r.rank ? `#${r.rank}` : "not in the top 200" })),
          initialValues: ranked.map((r) => r.keyword),
          required: false,
        }),
      );
      targets = picked as string[];
    }
    const extra = await textQ(targets.length ? "Any more? Comma separated" : "Type 3 to 5 searches people use to find apps like yours, comma separated", { placeholder: "Enter to skip", defaultValue: "" });
    targets = [...new Set([...targets, ...extra.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)])];
    if (targets.length) {
      project.spec.targets[country] = targets;
      await writeSpec(root, project.spec);
      p.log.success(`${targets.length} ${targets.length === 1 ? "target" : "targets"} in ${SPEC_FILE}`);
    }

    // 5. Where the listing stands
    if (pulled && targets.length) {
      s.start("Measuring keyword coverage");
      const lines = await captured(() => sub(["coverage", "--country", country])).catch((e: Error) => [c.red(e.message)]);
      s.stop("Keyword coverage");
      p.log.message(lines.join("\n"));
    }

    // 6. The coding agent: skills, specialists, then hand over
    const agent = await pickAgent();
    if (!agent) {
      p.note(`${cdHint ? `${cdHint}\n` : ""}npx skills add appeeky/appeeky-spec\nthen ask your agent to finish the setup`, "Later");
      p.outro(`Done. ${c.dim("`appeeky-spec doctor` shows what is set up and what is missing.")}`);
      return;
    }
    s.start(`Installing the Appeeky Spec skills for ${agent.label}`);
    const skills = await runQuiet("npx", ["-y", "skills", "add", "appeeky/appeeky-spec", "--agent", agent.skills, "--skill", "*", "--yes"], root);
    if (skills.code === 0) s.stop(`Skills installed for ${agent.label}`);
    else s.error(`The skills did not install. Run \`npx skills add appeeky/appeeky-spec\` in ${folder} later.`);
    if (agent.subagents) {
      const files = await installAgents(root, [agent.subagents]);
      p.log.success(`Specialists: ${files.map((f) => f.path.split("/").pop()!.replace(/\.md$/, "")).join(", ")}${agent.subagents === "claude" ? c.dim(`\n/${COFOUNDER_COMMAND} runs a growth review with them.`) : ""}`);
    }
    const prompt = setupPrompt({ name, pulled, hasTargets: targets.length > 0 });
    const installed = onPath(agent.bin);
    if (installed && need(await p.confirm({ message: `Open ${agent.label} here to finish the setup?` }))) {
      p.outro(`Starting ${c.cyan(agent.bin)} in ${folder}`);
      spawnSync(agent.bin, agent.launch(prompt), { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
      return;
    }
    p.note(`${cdHint ? `${cdHint}\n` : ""}${installed ? agent.bin : `install ${agent.label}, then start it`}\n\n${c.dim(prompt)}`, "Finish with your agent");
    p.outro("Done.");
  }

  /** Ask which coding agent the user works with; installed ones come first. */
  async function pickAgent(): Promise<CodingAgent | undefined> {
    const list = [...CODING_AGENTS].sort((a, b) => Number(onPath(b.bin)) - Number(onPath(a.bin)));
    const id = need(
      await p.select({
        message: "Which coding agent do you use?",
        options: [...list.map((a) => ({ value: a.id, label: a.label, hint: onPath(a.bin) ? undefined : "not installed" })), { value: "", label: "None / later" }],
      }),
    );
    return list.find((a) => a.id === id);
  }

  /**
   * Save a store key with the store's own CLI (`appstore accounts add`, `gps accounts add`), run
   * through npx: the key stays in the CLI's config on this machine, never in the repo.
   */
  async function saveStoreKey(store: StoreId, account: string, appId?: string): Promise<boolean> {
    const cli = STORE_CLIS[store];
    const fileExists = (v: string | undefined) => (v?.trim() && existsSync(resolve(v.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~"))) ? undefined : "No file at that path");
    const filePath = (v: string) => resolve(v.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    let args: string[];
    if (store === "app-store") {
      p.log.info(c.dim("App Store Connect → Users and Access → Integrations → App Store Connect API. Role App Manager to push."));
      const keyId = await textQ("Key ID", { validate: (v) => (/^[A-Z0-9]{10}$/.test(v?.trim() ?? "") ? undefined : "10 letters and digits, like 2X9R4HXF34") });
      const issuer = await textQ("Issuer ID", { placeholder: "Enter for an individual key", defaultValue: "", validate: (v) => (!v || /^[0-9a-f-]{36}$/i.test(v.trim()) ? undefined : "A UUID, like 57246542-96fe-1a63-e053-0824d011072a") });
      const path = await textQ("Path to the AuthKey_….p8 file", { validate: fileExists });
      args = ["accounts", "add", account, "--key-id", keyId.trim(), ...(issuer ? ["--issuer-id", issuer.trim()] : []), "--private-key-path", filePath(path), ...(appId ? ["--default-app", appId] : []), "--default"];
    } else {
      p.log.info(c.dim("A Google Cloud service account with the Android Publisher API, invited in Play Console → Users and permissions."));
      const path = await textQ("Path to its JSON key", { validate: fileExists });
      args = ["accounts", "add", account, "--credentials", filePath(path), ...(appId ? ["--default-package", appId] : []), "--default"];
    }
    const s = p.spinner();
    s.start(`Saving the key with the ${cli.bin} CLI`);
    const result = await runQuiet("npx", ["-y", "-p", cli.npmPackage, cli.bin, ...args], process.cwd());
    if (result.code === 0) {
      s.stop(`Saved as "${account}" in the ${cli.bin} CLI's config (not in this repo)`);
      return true;
    }
    s.error(`${cli.bin} accounts add failed`);
    p.log.message(c.dim(result.output.trim().split("\n").slice(-4).join("\n")));
    return false;
  }

  function logChecks(checks: DoctorCheck[]) {
    for (const x of checks) {
      const line = `${c.bold(x.area)}  ${x.detail}${x.fix && x.status !== "ok" ? `\n${c.dim(x.fix)}` : ""}`;
      if (x.status === "ok") p.log.success(line);
      else if (x.status === "warn") p.log.warn(line);
      else p.log.error(line);
    }
  }

  function printChecks(checks: DoctorCheck[]) {
    const mark = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") } as const;
    for (const x of checks) {
      console.log(`  ${mark[x.status]} ${x.area.padEnd(20)} ${x.detail}`);
      if (x.fix) console.log(`    ${c.dim(x.fix)}`);
    }
  }

  function printInstalled(files: InstalledFile[]) {
    const mark = { written: c.green("✓"), unchanged: c.dim("="), kept: c.yellow("!") } as const;
    for (const f of files) console.log(`  ${mark[f.status]} ${f.path}${f.status === "kept" ? c.dim("  (yours differs: kept, --force to replace)") : ""}`);
  }

  const agents = program.command("agents").description("Specialist subagents (ASO, reviews, ads, releases, UGC, social) and the co-founder review, for your coding agent");
  agents
    .command("install")
    .description(`Write the specialists and the /${COFOUNDER_COMMAND} command into this repo (${Object.values(TARGET_DIRS).map((d) => d.agents).join(", ")})`)
    .option("--for <targets>", "claude, opencode or all, comma separated", "claude")
    .option("--force", "Replace files you changed", false)
    .action(async (opts: { for: string; force: boolean }) => {
      const root = resolve(g().cwd);
      const files = await installAgents(root, parseTargets(opts.for), { force: opts.force });
      if (g().json) {
        printJson({ root, files });
        return;
      }
      printInstalled(files);
      console.log(c.dim(`Commit them. Then run /${COFOUNDER_COMMAND} in your agent, or schedule it (examples/weekly/).`));
    });

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
      // Screenshots are not pushed, so their errors warn instead of stopping the listing push.
      const shotErrors = (await checkScreenshots(project.root)).filter((i) => i.severity === "error");
      if (shotErrors.length > 0 && !g().json) console.error(`${formatIssues(shotErrors)}\n${c.yellow("Screenshots are not uploaded by push; fix these before you upload them.")}\n`);
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
    .description("Spend and installs of your paid channels: Apple Search Ads (from Appeeky, or appeeky/search-ads/ pulled with your own key), plus the Meta and TikTok campaigns under ads: (needs APPEEKY_API_KEY)")
    .option("--days <n>", "How many days, up to yesterday", "30")
    .option("--save", "Write the numbers to appeeky/ads/<date>.yaml", false)
    .action(async (opts: { days: string; save: boolean }) => {
      const project = await load();
      const a = api();
      const own = searchAdsMetricSource(project.root);
      if (!a && !own) throw new Error("Set APPEEKY_API_KEY (ad data from the channels you connected in Appeeky), or pull Apple Search Ads with your own key: appeeky-spec search-ads pull.");
      const snapshot = await adsSnapshot(a ?? null, project.spec, experimentApp(project, {}), Number(opts.days) || 30, new Date(), own);
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
      const drafts = (await readReplies(project.root)).filter((r) => r.status === "draft");
      if (drafts.length === 0) {
        if (g().json) printJson({ sent: [] });
        else console.log(c.dim("No draft replies."));
        return;
      }
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: replies are sent through the store connections in Appeeky.");
      const blocked = drafts.filter((r) => replyIssues(r).length);
      if (blocked.length) throw new Error(`Too long: ${blocked.map((r) => `${r.id} (${replyIssues(r).join(", ")})`).join("; ")}`);
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

  const social = program.command("social").description("Organic social media in the repo: accounts, posts and their results, posts sent through a pull request, and comments to answer (needs APPEEKY_API_KEY)");
  social
    .command("pull")
    .description("Write the connected accounts, recent posts and their analytics, posts made in the platform apps, comments and followers to appeeky/social/, and summary.md")
    .option("--limit <n>", "How many recent posts", "100")
    .action(async (opts: { limit: string }) => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: posts come from the social accounts connected in Appeeky.");
      const data = await fetchSocial(a, { limit: Number(opts.limit) || 100 });
      await saveSocial(project.root, data);
      if (g().json) {
        printJson({ accounts: data.accounts.length, posts: data.posts.length, nativePosts: data.nativePosts?.length ?? null, comments: data.comments?.length ?? null, insights: data.insights?.length ?? null, warnings: data.warnings ?? [] });
        return;
      }
      console.log(`${c.bold("Accounts")} ${data.accounts.map((x) => `${x.platform} (${x.name})`).join(", ") || c.dim("none connected")}`);
      console.log(`${c.bold("Posts")}    ${data.posts.length} through Appeeky · ${data.posts.filter((p) => p.platforms.some((x) => x.publishedAt)).length} published${data.nativePosts ? ` · ${data.nativePosts.length} made in the apps` : ""}`);
      if (data.comments) console.log(`${c.bold("Comments")} ${data.comments.length}`);
      for (const w of data.warnings ?? []) console.log(`${c.yellow("warn ")} ${w}`);
      const files = ["accounts.yaml", "posts.jsonl", data.nativePosts && "native-posts.jsonl", data.comments && "comments.jsonl", data.insights && "insights.yaml", "summary.md"].filter(Boolean);
      console.log(c.dim(`Written to appeeky/social/: ${files.join(", ")}.`));
    });

  social
    .command("check")
    .description("Check the drafts in appeeky/social/drafts/: which account each goes to, length, media, TikTok and YouTube options, time")
    .action(async () => {
      const project = await load();
      const accounts = await readAccounts(project.root);
      const drafts = (await readDrafts(project.root)).filter((d) => d.status === "draft");
      const results = drafts.map((d) => ({ file: d.file.replace(project.root + "/", ""), issues: draftIssues(d, accounts) }));
      if (g().json) printJson({ drafts: results });
      else if (!results.length) console.log(c.dim("No drafts in appeeky/social/drafts/."));
      else for (const r of results) console.log(`${r.issues.length ? c.red("✗") : c.green("✓")} ${r.file}${r.issues.length ? `\n  ${c.dim(r.issues.join("; "))}` : ""}`);
      if (results.some((r) => r.issues.length)) process.exitCode = 1;
    });

  social
    .command("push")
    .description("Send the drafts in appeeky/social/drafts/: each goes out now, or at its `when`")
    .option("--yes", "Send without asking", false)
    .action(async (opts: { yes: boolean }) => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: posts go out through the social accounts connected in Appeeky.");
      const accounts = await readAccounts(project.root);
      const drafts = (await readDrafts(project.root)).filter((d) => d.status === "draft");
      const blocked = drafts.filter((d) => draftIssues(d, accounts).length);
      if (blocked.length) throw new Error(`Fix first (appeeky-spec social check): ${blocked.map((d) => `${d.file.replace(project.root + "/", "")} (${draftIssues(d, accounts).join("; ")})`).join("; ")}`);
      if (drafts.length === 0) {
        if (g().json) printJson({ sent: [] });
        else console.log(c.dim("No drafts to send."));
        return;
      }
      if (!g().json)
        for (const d of drafts) {
          const to = resolveAccounts(d, accounts).accounts.map((x) => `${x.platform} (${x.name})`).join(", ");
          console.log(`${c.bold(d.file.replace(project.root + "/", ""))} ${c.dim(`→ ${to}, ${d.when ? `at ${d.when}` : "now"}`)}\n  ${d.text}`);
        }
      if (!opts.yes && !(await confirm(`Publish ${drafts.length} post${drafts.length === 1 ? "" : "s"}? They go out on the accounts above.`))) return;
      const sent: Array<{ file: string; postId: string }> = [];
      const failed: Array<{ file: string; message: string }> = [];
      for (const d of drafts) {
        const file = d.file.replace(project.root + "/", "");
        try {
          sent.push({ file, postId: await sendDraft(a, d, accounts) });
        } catch (e) {
          failed.push({ file, message: (e as Error).message });
        }
      }
      if (g().json) printJson({ sent, failed });
      else {
        console.log(c.green(`Sent ${sent.length}.`));
        for (const f of failed) console.log(`${c.red(f.file)} ${c.dim(f.message)}`);
      }
      if (failed.length) process.exitCode = 1;
    });

  const socialApi = () => {
    const a = api();
    if (!a) throw new Error("Set APPEEKY_API_KEY: comments come from the social accounts connected in Appeeky.");
    return a;
  };

  social
    .command("comments")
    .description("Comments on your posts, newest first, with what you can do to each (reply, hide, like, delete)")
    .option("--unanswered", "Only other people's comments you have not replied to", false)
    .option("--account <account>", "Only this account: its id, or a handle from appeeky/social/accounts.yaml (tiktok:@handle)")
    .option("--post <id>", "Only comments on this post (an Appeeky post id)")
    .option("--limit <n>", "How many (up to 200)", "50")
    .action(async (opts: { unanswered: boolean; account?: string; post?: string; limit: string }) => {
      const a = socialApi();
      const accounts = await readAccounts(resolve(g().cwd));
      let accountId = opts.account;
      if (opts.account) {
        const found = resolveAccounts({ accounts: [opts.account] }, accounts);
        if (found.ambiguous.length) throw new Error(`${opts.account} matches several accounts (${found.ambiguous[0]!.choices.join(", ")}): name one`);
        if (found.accounts.length === 1) accountId = found.accounts[0]!.id;
      }
      const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
      const comments = await listComments(a, { unanswered: opts.unanswered, accountId, postId: opts.post, limit }, accounts);
      if (g().json) {
        printJson({ comments });
        return;
      }
      if (!comments.length) {
        console.log(c.dim(opts.unanswered ? "No unanswered comments." : "No comments."));
        return;
      }
      for (const x of comments) {
        const state = x.own ? c.dim(" (you)") : x.repliedAt ? c.green(" replied") : x.hidden ? c.dim(" hidden") : "";
        console.log(`${c.bold(x.id)} ${x.platform} ${x.account}${x.at ? c.dim(` ${x.at.slice(0, 16).replace("T", " ")}`) : ""}${state}`);
        console.log(`  ${x.author ? `${x.author}: ` : ""}${x.text}`);
        if (x.replyText) console.log(c.dim(`  ↳ ${x.replyText}`));
      }
      if (opts.unanswered) console.log(c.dim(`\nReply with: appeeky-spec social reply <id> "<message>"`));
    });

  social
    .command("reply")
    .description("Reply to a comment from the account it is on. Checks the platform's length limit first")
    .argument("<commentId>", "The comment id from `social comments`")
    .argument("<message>", "The reply")
    .action(async (commentId: string, message: string) => {
      const a = socialApi();
      const platform = await commentPlatform(a, resolve(g().cwd), commentId);
      const result = await replyToComment(a, commentId, message, platform);
      if (g().json) printJson(result);
      else console.log(c.green(`Replied to ${commentId}${platform ? ` on ${platform}` : ""}.`));
    });

  social
    .command("hide")
    .description("Hide a comment from the public (Facebook, Instagram, Threads, X, TikTok)")
    .argument("<commentId>", "The comment id from `social comments`")
    .option("--unhide", "Show it again", false)
    .action(async (commentId: string, opts: { unhide: boolean }) => {
      const result = await hideComment(socialApi(), commentId, !opts.unhide);
      if (g().json) printJson({ commentId, ...result });
      else console.log(c.green(`${result.hidden ? "Hid" : "Unhid"} ${commentId}.`));
    });

  social
    .command("like")
    .description("Like a comment from the account it is on")
    .argument("<commentId>", "The comment id from `social comments`")
    .action(async (commentId: string) => {
      await likeComment(socialApi(), commentId);
      if (g().json) printJson({ commentId, liked: true });
      else console.log(c.green(`Liked ${commentId}.`));
    });

  social
    .command("delete-comment")
    .description("Delete a comment on the platform. Asks first; pass --yes when not in a terminal")
    .argument("<commentId>", "The comment id from `social comments`")
    .option("-y, --yes", "Delete without asking", false)
    .action(async (commentId: string, opts: { yes: boolean }) => {
      const a = socialApi();
      if (!opts.yes) {
        if (!process.stdin.isTTY) throw new Error("Not a terminal: pass --yes to delete the comment. Deleting can't be undone.");
        if (!(await confirm(`Delete comment ${commentId}? This can't be undone.`))) {
          if (g().json) printJson({ commentId, deleted: false });
          else console.log(c.dim("Not deleted."));
          return;
        }
      }
      await deleteComment(a, commentId);
      if (g().json) printJson({ commentId, deleted: true });
      else console.log(c.green(`Deleted ${commentId}.`));
    });

  const ugc = program.command("ugc").description("UGC from your Appeeky creator personas: clips in the repo, and videos made from briefs (needs APPEEKY_API_KEY)");
  ugc
    .command("pull")
    .description("Write your creator personas and their clips to appeeky/ugc/")
    .option("--limit <n>", "How many recent clips", "100")
    .action(async (opts: { limit: string }) => {
      const project = await load();
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: personas and clips come from Appeeky UGC.");
      const data = await fetchUgc(a, { limit: Number(opts.limit) || 100 });
      await saveUgc(project.root, data);
      if (g().json) {
        printJson({ personas: data.personas.length, clips: data.clips.length });
        return;
      }
      console.log(`${c.bold("Personas")} ${data.personas.map((p) => `${p.name}${p.ready ? "" : c.dim(" (no look yet)")}`).join(", ") || c.dim("none yet: create one in Appeeky (UGC)")}`);
      console.log(`${c.bold("Clips")}    ${data.clips.length}`);
      console.log(c.dim("Written to appeeky/ugc/: personas.yaml, clips.jsonl."));
    });

  ugc
    .command("generate")
    .description("Make a clip from each draft brief in appeeky/ugc/briefs/ (uses Appeeky media credits, or your own fal key with --local)")
    .option("--dry-run", "Only show what each clip would cost", false)
    .option("--yes", "Generate without asking", false)
    .option("--local", "Render here with your own FAL_KEY (fal bills you; no Appeeky credits)", false)
    .action(async (opts: { dryRun: boolean; yes: boolean; local: boolean }) => {
      const project = await load();
      if (opts.local) return generateLocalClips(project.root, opts);
      const a = api();
      if (!a) throw new Error("Set APPEEKY_API_KEY: clips are made with Appeeky UGC.");
      const personas = await readPersonas(project.root);
      const briefs = (await readBriefs(project.root)).filter((b) => b.status === "draft");
      const unknown = briefs.filter((b) => !findPersona(b, personas));
      if (unknown.length) throw new Error(`Unknown persona (run \`appeeky-spec ugc pull\`): ${unknown.map((b) => `${b.persona} in ${b.file.replace(project.root + "/", "")}`).join("; ")}`);
      const notReady = briefs.filter((b) => findPersona(b, personas)!.ready === false);
      if (notReady.length) throw new Error(`Pick a look (reference images) in Appeeky UGC first for: ${[...new Set(notReady.map((b) => b.persona))].join(", ")}`);
      if (briefs.length === 0) {
        if (g().json) printJson({ briefs: [] });
        else console.log(c.dim("No draft briefs in appeeky/ugc/briefs/."));
        return;
      }
      const quotes = [];
      for (const b of briefs) quotes.push({ file: b.file.replace(project.root + "/", ""), persona: b.persona, ...(await quoteBrief(a, b, findPersona(b, personas)!)) });
      const credits = quotes.reduce((n, q) => n + q.credits, 0);
      if (!g().json) for (const q of quotes) console.log(`${c.bold(q.file)} ${c.dim(`${q.persona} · ${q.credits} credits${q.affordable ? "" : " · not enough credits"}`)}`);
      if (opts.dryRun) {
        if (g().json) printJson({ dryRun: true, briefs: quotes, credits });
        else console.log(c.dim(`\n${credits} credits in all. Nothing was made.`));
        return;
      }
      if (quotes.some((q) => !q.affordable)) throw new Error("Not enough media credits for every brief. Top up in Appeeky, or remove a brief.");
      if (!opts.yes && !(await confirm(`Make ${briefs.length} clip${briefs.length === 1 ? "" : "s"} for ${credits} credits?`))) return;
      const made = [];
      for (const b of briefs) made.push({ file: b.file.replace(project.root + "/", ""), ...(await generateBrief(a, b, findPersona(b, personas)!)) });
      if (g().json) printJson({ made, credits });
      else console.log(c.green(`Started ${made.length}. They render in Appeeky; \`appeeky-spec ugc pull\` records them when done.`));
    });

  async function generateLocalClips(root: string, opts: { dryRun: boolean; yes: boolean }) {
    const falKey = process.env.FAL_KEY?.trim();
    if (!falKey && !opts.dryRun) throw new Error("Set FAL_KEY (fal.ai → API keys): local clips are billed to your fal account.");
    const briefs = (await readBriefs(root)).filter((b) => b.status === "draft");
    if (briefs.length === 0) {
      if (g().json) printJson({ briefs: [] });
      else console.log(c.dim("No draft briefs in appeeky/ugc/briefs/."));
      return;
    }
    const core = await loadCore();
    const a = api();
    const personas = new Map<string, LocalPersona>();
    for (const b of briefs) {
      if (personas.has(b.persona)) continue;
      const p = (await readLocalPersona(root, b.persona)) ?? (a ? await readAppeekyPersona(a, b.persona) : undefined);
      if (!p) throw new Error(`Unknown persona ${b.persona}: add appeeky/ugc/personas/${b.persona.toLowerCase()}.yaml with its looks${a ? "" : ", or set APPEEKY_API_KEY to use one from Appeeky"}.`);
      personas.set(b.persona, p);
    }
    const rel = (f: string) => f.replace(root + "/", "");
    const quotes = briefs.map((b) => {
      const plan = planLocalClip(core, personas.get(b.persona)!, b, []);
      return { file: rel(b.file), persona: b.persona, ...plan.clip, costUsd: plan.costUsd };
    });
    const total = Math.round(quotes.reduce((n, q) => n + q.costUsd, 0) * 100) / 100;
    if (!g().json) for (const q of quotes) console.log(`${c.bold(q.file)} ${c.dim(`${q.persona} · ${q.durationSec}s ${q.aspectRatio} · ${q.videoModelId} · about $${q.costUsd.toFixed(2)} on fal`)}`);
    if (opts.dryRun) {
      if (g().json) printJson({ dryRun: true, local: true, briefs: quotes, costUsd: total });
      else console.log(c.dim(`\nAbout $${total.toFixed(2)} on your fal account in all. Nothing was made.`));
      return;
    }
    if (!opts.yes && !(await confirm(`Make ${briefs.length} clip${briefs.length === 1 ? "" : "s"} on fal for about $${total.toFixed(2)}?`))) return;
    const made = [];
    for (const b of briefs) {
      if (!g().json) console.log(c.bold(rel(b.file)));
      const r = await generateLocal(core, root, b, personas.get(b.persona)!, falKey!, { log: (l) => !g().json && console.log(c.dim(`  ${l}`)) });
      made.push({ file: rel(b.file), clip: rel(r.file), videoUrl: r.videoUrl, costUsd: r.costUsd });
      if (!g().json) console.log(`  ${c.green("✓")} ${rel(r.file)}`);
    }
    if (g().json) printJson({ made, costUsd: total });
    else console.log(c.dim("\nThe clips are in .appeeky/media/ (gitignored); each brief has its videoUrl for a social draft's media:."));
  }

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
    .description("Whether ChatGPT, Claude, Gemini and Perplexity name your app: from Appeeky AI Visibility (APPEEKY_API_KEY), or with --local on your own model keys");
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
    .option("--local", `Write them with your own model key (${KEY_NAMES}) instead of Appeeky`, false)
    .action(async (opts: { country?: string; local: boolean }) => {
      if (opts.local) return initLocal(opts.country);
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
    .description("Ask the assistants now: in Appeeky (AI Visibility credits), or with --local on your own model keys")
    .option("--country <cc>", "One storefront only")
    .option("--local", `Ask them from here with your own keys (${KEY_NAMES}) and write appeeky/visibility/`, false)
    .option("--every <days>", "With --local: skip a storefront scanned in the last <days> days (for a daily schedule)")
    .option("--dry-run", "With --local: show the prompts, assistants and cost, and ask nothing", false)
    .option("-y, --yes", "With --local: do not ask before spending", false)
    .action(async (opts: { country?: string; local: boolean; every?: string; dryRun: boolean; yes: boolean }) => {
      if (opts.local) return scanLocalCmd(opts);
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

  async function initLocal(country?: string) {
    const project = await load();
    const core = await loadVisibilityCore();
    const helper = core.helperFor(process.env);
    if (!helper) throw new Error(`Set ${KEY_NAMES}: the intents and prompts are written by your own model.`);
    const t = visibilityTarget(project);
    const countries = country ? [country.toLowerCase()] : (t?.countries ?? [Object.keys(project.spec.targets)[0] ?? "us"]);
    const spec = project.spec;
    spec.aiVisibility ??= { intents: {} };
    let cost = 0;
    const report: Array<{ country: string; intents: number; skipped?: boolean }> = [];
    for (const cc of countries) {
      const have = spec.aiVisibility.intents[cc] ?? [];
      if (have.length) {
        report.push({ country: cc, intents: have.length, skipped: true });
        continue;
      }
      const r = await core.generateIntents(helper, appContext(project, cc));
      cost += r.costUsd;
      spec.aiVisibility.intents[cc] = r.intents;
      report.push({ country: cc, intents: r.intents.length });
    }
    if (country && t && !t.countries.includes(countries[0]!)) spec.aiVisibility.countries = [...t.countries, countries[0]!];
    if (report.some((r) => !r.skipped && r.intents)) await writeSpec(project.root, spec);
    if (g().json) {
      printJson({ model: helper.modelId, costUsd: cost, report });
      return;
    }
    for (const r of report) {
      if (r.skipped) console.log(c.dim(`${r.country.toUpperCase()}: already has ${r.intents} intents in appeeky.spec.yaml; edit them there.`));
      else console.log(`${c.green("✓")} ${r.country.toUpperCase()}: wrote ${r.intents} intents to aiVisibility.intents in appeeky.spec.yaml`);
    }
    console.log(c.dim(`\n${helper.modelId} on your key, about $${cost.toFixed(3)}. Edit them, then: appeeky-spec visibility scan --local --dry-run`));
  }

  async function scanLocalCmd(opts: { country?: string; every?: string; dryRun: boolean; yes: boolean }) {
    const project = await load();
    const core = await loadVisibilityCore();
    const t = visibilityTarget(project);
    const all = Object.keys(project.spec.aiVisibility?.intents ?? {});
    const countries = opts.country ? [opts.country.toLowerCase()] : (t?.countries ?? all).filter((cc) => all.includes(cc));
    if (countries.length === 0) throw new Error("No aiVisibility.intents in appeeky.spec.yaml. Write them with appeeky-spec visibility init --local.");
    const every = opts.every ? Number(opts.every) : 0;
    const plans: LocalScanPlan[] = [];
    for (const cc of countries) {
      const since = every ? await daysSinceLocalScan(project.root, cc) : null;
      if (since !== null && since < every) {
        if (!g().json) console.log(c.dim(`${cc.toUpperCase()}: scanned ${since} day${since === 1 ? "" : "s"} ago, next in ${every - since}.`));
        continue;
      }
      plans.push(planLocalScan(core, project, cc, process.env));
    }
    if (plans.length === 0) return;
    if (!plans[0]!.helper || plans[0]!.models.length === 0) throw new Error(`Set ${KEY_NAMES} to scan with your own keys. Each key adds that assistant.`);
    const total = plans.reduce((n, p) => n + p.quoteUsd, 0);
    if (!g().json || opts.dryRun) {
      for (const p of plans) console.log(`${p.country.toUpperCase()}  ${p.intents.length} intents · ${p.prompts} prompts × ${p.models.join(", ")} · about $${p.quoteUsd.toFixed(2)}`);
      const missing = core.MODELS.filter((m) => !plans[0]!.models.includes(m));
      if (missing.length) console.log(c.dim(`Not asked (no key): ${missing.join(", ")}.`));
    }
    if (opts.dryRun) {
      if (g().json) printJson({ plans: plans.map(({ helper, ...p }) => ({ ...p, extractor: helper?.modelId })), totalUsd: total });
      else console.log(c.dim(`About $${total.toFixed(2)} on your own keys in all. Nothing was asked.`));
      return;
    }
    if (!opts.yes && !(await confirm(`Ask the assistants for about $${total.toFixed(2)} on your own keys?`))) return;
    const results = [];
    for (const p of plans) {
      const r = await scanLocal(core, project, p, process.env, { log: g().json ? undefined : (l) => console.log(c.dim(`  ${p.country.toUpperCase()} ${l}`)) });
      results.push(r);
    }
    if (g().json) {
      printJson(results.map(({ data, ...r }) => ({ ...r, summary: data.summary })));
      return;
    }
    for (const r of results) {
      const s = r.data.summary;
      console.log(`${c.green("✓")} ${r.file.replace(project.root + "/", "")}  ${c.green(`${s.winning} named`)} · ${c.yellow(`${s.weak} weak`)} · ${c.red(`${s.missing} missing`)}  ${c.dim(`$${r.costUsd.toFixed(2)}`)}`);
      for (const i of r.data.intents.filter((x) => x.status === "missing").slice(0, 3)) console.log(`  ${c.red("missing")} "${i.label}"${i.namedInstead ? c.dim(`: they name ${i.namedInstead.slice(0, 3).join(", ")}`) : ""}`);
      for (const ch of r.changes) console.log(`  ${c.yellow("changed")} ${ch}`);
      const failedBy = [...new Set(r.failed.map((f) => f.model))];
      for (const m of failedBy) console.log(`  ${c.red("✗")} ${m}: ${r.failed.find((f) => f.model === m)!.error}`);
    }
  }

  const searchAds = program.command("search-ads").description("Apple Search Ads on your own API key: this app's spend, installs, keywords and search terms in appeeky/search-ads/");
  searchAds
    .command("pull")
    .description("Write spend and installs per day, keywords and search terms to appeeky/search-ads/ (the Search Ads key on your appstore CLI account, or ASA_* env)")
    .option("--days <n>", "How many days, up to yesterday", "30")
    .action(async (opts: { days: string }) => {
      const project = await load();
      const { label, source } = await searchAdsSource(project);
      let r;
      try {
        r = await pullSearchAds(project, new SearchAdsClient(source), new Date(), Number(opts.days) || 30);
      } catch (e) {
        const msg = (e as Error).message;
        if (label.startsWith("appstore") && /no Apple Search Ads key|Could not start|AUTH_ERROR/i.test(msg)) {
          throw new Error(`${msg}\nSave the Search Ads key on your App Store Connect CLI account (appstore accounts search-ads <account> --client-id … --team-id … --key-id … --private-key-path …), or set ASA_CLIENT_ID, ASA_TEAM_ID, ASA_KEY_ID and ASA_PRIVATE_KEY.`);
        }
        throw e;
      }
      if (g().json) {
        printJson(r);
        return;
      }
      const money = (n: number) => `${n.toFixed(2)}${r.currency ? ` ${r.currency}` : ""}`;
      if (r.campaigns.length === 0) {
        console.log(c.yellow(`No campaign for App Store id ${project.spec.stores.appStore?.appId} in org ${r.orgId}.`));
        return;
      }
      console.log(`${c.green("✓")} appeeky/search-ads/  ${r.campaigns.map((x) => x.name).join(", ")}`);
      console.log(`  ${opts.days} days: ${money(r.last30.spend)} · ${r.last30.installs} installs${r.last30.installs ? ` · ${money(r.last30.spend / r.last30.installs)} each` : ""} · ${r.last30.taps} taps`);
      console.log(c.dim(`  ${r.keywords} keywords, ${r.searchTerms} search terms. Read appeeky/search-ads/summary.md.`));
      for (const e of r.errors) console.log(`  ${c.yellow("!")} ${e}`);
    });

  const seo = program.command("seo").description("The app's website in Google and in AI answers: check it, write llms.txt, and pull Search Console with your own service account");
  const siteUrl = (project: Project, url?: string) => {
    const u = url ?? project.spec.web?.url;
    if (!u) throw new Error("Pass the site's URL, or set web.url in appeeky.spec.yaml.");
    return u;
  };
  seo
    .command("check")
    .description("Read the site like a crawler: what is missing for search, for the app and for AI assistants")
    .argument("[url]", "Page to check (default: web.url)")
    .action(async (url?: string) => {
      const project = await load();
      const target = siteUrl(project, url);
      const checks = await checkSite(project, target);
      if (g().json) {
        printJson({ url: target, checks });
        return;
      }
      const titles: Record<SiteCheck["area"], string> = { search: "Search", app: "The app", ai: "AI assistants" };
      for (const area of ["search", "app", "ai"] as const) {
        const list = checks.filter((x) => x.area === area);
        if (!list.length) continue;
        console.log(c.bold(`\n${titles[area]}`));
        for (const x of list) {
          const mark = x.level === "ok" ? c.green("✓") : x.level === "warn" ? c.yellow("!") : c.red("✗");
          console.log(`  ${mark} ${x.message}${x.fix ? c.dim(`\n      ${x.fix}`) : ""}`);
        }
      }
      const bad = checks.filter((x) => x.level !== "ok").length;
      console.log(c.dim(`\n${checks.length - bad} of ${checks.length} fine.`));
      if (checks.some((x) => x.level === "fail")) process.exitCode = 1;
    });
  const dfs = () => {
    const auth = readDataForSeo(process.env);
    if (!auth) throw new Error("Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (app.dataforseo.com → API access). DataForSEO bills each call.");
    return auth;
  };
  const quoted = async (project: Project, what: "ranks" | "keywords" | "domain", opts: { dryRun: boolean; yes: boolean }) => {
    const sets = webKeywords(project);
    if (what !== "domain" && Object.keys(sets).length === 0) throw new Error("No keywords: add web.keywords.<country> (or targets) to appeeky.spec.yaml.");
    const usd = quoteSeo(project, what);
    const n = Object.values(sets).reduce((a, k) => a + k.length, 0);
    if (!g().json || opts.dryRun) console.log(`${what === "domain" ? `${project.spec.web?.url ?? ""}` : `${n} keywords in ${Object.keys(sets).map((x) => x.toUpperCase()).join(", ")}`} · about $${usd.toFixed(2)} on DataForSEO`);
    if (opts.dryRun) {
      if (!g().json) console.log(c.dim("Nothing was asked."));
      else printJson({ what, keywords: sets, quoteUsd: usd });
      return false;
    }
    return opts.yes || (await confirm(`Spend about $${usd.toFixed(2)} on DataForSEO?`));
  };
  seo
    .command("ranks")
    .description("Where the site and the app's store page rank on Google for each keyword, and whether the AI Overview cites the site (DataForSEO)")
    .option("--every <days>", "Skip when the last check is newer than <days> days (for a daily schedule)")
    .option("--dry-run", "Show the keywords and the cost, ask nothing", false)
    .option("-y, --yes", "Do not ask before spending", false)
    .action(async (opts: { every?: string; dryRun: boolean; yes: boolean }) => {
      const project = await load();
      const auth = opts.dryRun ? null : dfs();
      if (opts.every) {
        const since = await daysSinceRanks(project.root);
        if (since !== null && since < Number(opts.every)) {
          if (!g().json) console.log(c.dim(`Checked ${since} day${since === 1 ? "" : "s"} ago; next in ${Number(opts.every) - since}.`));
          return;
        }
      }
      if (!(await quoted(project, "ranks", opts))) return;
      const r = await pullRanks(project, auth!);
      if (g().json) {
        printJson(r);
        return;
      }
      const ranked = r.ranks.filter((x) => x.position !== null);
      console.log(`${c.green("✓")} appeeky/seo/ranks.md  ${ranked.length} of ${r.ranks.length} in the top 100 · ${r.ranks.filter((x) => x.position !== null && x.position <= 10).length} in the top 10 · AI Overview cites you ${r.ranks.filter((x) => x.aiCitesYou).length}×  ${c.dim(`$${r.costUsd.toFixed(3)}`)}`);
      for (const x of r.ranks.slice(0, 10)) {
        const ai = x.aiOverview ? (x.aiCitesYou ? c.green("AI cites you") : c.dim(`AI cites ${x.aiCited.slice(0, 2).join(", ") || "no one"}`)) : "";
        console.log(`  ${x.country.toUpperCase()} ${x.keyword.padEnd(28)} site ${String(x.position ?? "—").padEnd(4)} store page ${String(x.storePosition ?? "—").padEnd(4)} ${ai}`);
      }
      for (const ch of r.changes) console.log(`  ${c.yellow("changed")} ${ch}`);
      for (const e of r.errors) console.log(`  ${c.red("✗")} ${e}`);
    });
  seo
    .command("keywords")
    .description("Search volume, difficulty, CPC and intent for the keywords, and related ideas, into appeeky/seo/keywords.csv (DataForSEO)")
    .option("--dry-run", "Show the cost, ask nothing", false)
    .option("-y, --yes", "Do not ask before spending", false)
    .action(async (opts: { dryRun: boolean; yes: boolean }) => {
      const project = await load();
      const auth = opts.dryRun ? null : dfs();
      if (!(await quoted(project, "keywords", opts))) return;
      const r = await pullKeywords(project, auth!);
      if (g().json) {
        printJson(r);
        return;
      }
      const tracked = r.rows.filter((x) => x.tracked);
      console.log(`${c.green("✓")} appeeky/seo/keywords.csv  ${tracked.length} keywords, ${r.rows.length - tracked.length} ideas  ${c.dim(`$${r.costUsd.toFixed(3)}`)}`);
      for (const x of tracked.slice(0, 8)) console.log(`  ${x.keyword.padEnd(30)} ${String(x.volume ?? "—").padStart(7)}/mo  difficulty ${x.difficulty ?? "—"}`);
      const ideas = r.rows.filter((x) => !x.tracked && (x.volume ?? 0) > 0).slice(0, 5);
      if (ideas.length) console.log(c.dim(`  ideas: ${ideas.map((x) => `${x.keyword} (${x.volume})`).join(", ")}`));
    });
  seo
    .command("domain")
    .description("What the site ranks for, its estimated visits and the sites it competes with, into appeeky/seo/domain.md (DataForSEO)")
    .option("--dry-run", "Show the cost, ask nothing", false)
    .option("-y, --yes", "Do not ask before spending", false)
    .action(async (opts: { dryRun: boolean; yes: boolean }) => {
      const project = await load();
      const auth = opts.dryRun ? null : dfs();
      if (!(await quoted(project, "domain", opts))) return;
      const { report, costUsd } = await pullDomain(project, auth!);
      if (g().json) {
        printJson({ ...report, costUsd });
        return;
      }
      console.log(`${c.green("✓")} appeeky/seo/domain.md  ${report.domain} ${report.country.toUpperCase()}: ${report.keywords} keywords · ${report.top10} in the top 10 · ~${report.traffic} visits/mo  ${c.dim(`$${costUsd.toFixed(3)}`)}`);
      if (report.competitors.length) console.log(c.dim(`  competes with ${report.competitors.slice(0, 5).map((x) => x.domain).join(", ")}`));
    });
  seo
    .command("llms")
    .description("Write llms.txt from the listing: what the app is, where to get it, and its description")
    .option("--out <file>", "Write it to a file, e.g. public/llms.txt (default: print it)")
    .action(async (opts: { out?: string }) => {
      const project = await load();
      const text = llmsTxt(project);
      if (!opts.out) {
        process.stdout.write(text);
        return;
      }
      const file = resolve(g().cwd, opts.out);
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, text);
      if (!g().json) console.log(`${c.green("✓")} ${opts.out}`);
    });
  seo
    .command("pull")
    .description("Google Search Console clicks, impressions, queries and pages into appeeky/seo/ (needs GSC_CREDENTIALS)")
    .action(async () => {
      const project = await load();
      const sa = await readServiceAccount(process.env, { gcloud: true });
      if (!sa) throw new Error("Set GSC_CREDENTIALS to a Google service account JSON key (or its path) and add its email as a user of the property in Search Console, or log in on this machine: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform");
      if (!searchConsoleProperty(project)) throw new Error("Set web.url in appeeky.spec.yaml first.");
      const r = await pullSearchConsole(project, sa);
      if (g().json) {
        printJson(r);
        return;
      }
      const pct = (a: number, b: number) => (b > 0 ? c.dim(` (${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%)`) : "");
      console.log(`${c.green("✓")} appeeky/seo/  ${r.property}`);
      console.log(`  last 28 days: ${r.last28.clicks} clicks${pct(r.last28.clicks, r.previous28.clicks)} · ${r.last28.impressions} impressions${pct(r.last28.impressions, r.previous28.impressions)}`);
      console.log(c.dim(`  ${r.queries} queries, ${r.pages} pages. Read appeeky/seo/summary.md.`));
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
      const localVisibility = localVisibilityMetricSource(project);
      const search = seoMetricSource(project.root);
      const ownAds = searchAdsMetricSource(project.root);
      const webRank = webRankMetricSource(project.root);
      const metrics = combineSources([
        ...(a ? [metricSourceFor(a, project.spec)] : []),
        ...(visibility ? [visibility] : []),
        ...(localVisibility ? [localVisibility] : []),
        ...(search ? [search] : []),
        ...(ownAds ? [ownAds] : []),
        ...(webRank ? [webRank] : []),
        categoryMetricSource(project.root),
        reviewMetricSource(project.root),
        ...(hasClients(attribution) ? [attributionMetricSource(attribution)] : []),
      ]);
      const results = await verifyReleases(project, rankSource(), { ids: ids.length ? ids : undefined, force: opts.now, metrics });
      const measured = await measureExperiments(project, metrics, new Date(), linkValueReader(project.spec, a));
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
      // The experiment's own smart link: its clicks, or the installs and revenue counted to it.
      if (value === undefined) value = await linkValueReader(project.spec, a)(e).catch(() => undefined);
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
    .description("Markdown for a pull request: listing changes, listing and screenshot checks, coverage against a base ref, and the replies, posts and clips a merge sends out")
    .option("--base <ref>", "Git ref to compare with", "origin/main")
    .option("-o, --output <file>", "Write the report to a file")
    .action(async (opts: { base: string; output?: string }) => {
      const project = await load();
      const base = await loadProjectAtRef(project.root, opts.base);
      const shots = await checkScreenshots(project.root);
      const md = specReport(base, project, shots) + (await outboxReport(project.root));
      if (opts.output) await writeFile(opts.output, `${md}\n`);
      else console.log(md);
      if (hasErrors([...lintProject(project), ...shots])) process.exitCode = 1;
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

