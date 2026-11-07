import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SPEC_DIR } from "./files.js";
import { closeExperiment, dueExperiments, readExperiments, writeExperiment, type Experiment } from "./experiments.js";
import { readReleases, releaseAge, updateRelease, type ReleaseRecord } from "./history.js";
import type { Project, StoreId } from "./schema.js";
import { formatChange, isMetricName, measureAround, metricAfter, outcomeVerdict, type MetricSource } from "./metrics.js";
import { compareWithControl, MIN_NET_PLACES } from "./control.js";
import { evaluateRanks, measureConversion, rankAppIds, type ConversionSource, type ConversionWindow, type RankSnapshot, type RankSource } from "./verify.js";

/** Days after a push when a release is measured. */
export const CHECK_DAYS = [7, 14] as const;

export interface VerifyResult {
  release: ReleaseRecord;
  check: NonNullable<ReleaseRecord["checks"]>[number];
}

/** The next milestone a release is due for, or null when it is not due (or already checked). */
export function dueMilestone(record: ReleaseRecord, now = new Date()): number | null {
  if (!record.baseline) return null;
  const age = releaseAge(record, now);
  const done = new Set((record.checks ?? []).map((c) => c.day));
  const due = CHECK_DAYS.filter((d) => age >= d && !done.has(d));
  return due.length > 0 ? due.at(-1)! : null;
}

/**
 * Measure releases against their baseline ranks and write the result into
 * each release file. By default only releases that reached a milestone
 * (day 7, day 14) are measured; `force` measures the given ones now.
 */
export async function verifyReleases(
  project: Project,
  source: RankSource,
  options: { ids?: string[]; force?: boolean; now?: Date; conversion?: ConversionSource; metrics?: MetricSource } = {},
): Promise<VerifyResult[]> {
  const now = options.now ?? new Date();
  const ids = rankAppIds(project);
  const releases = (await readReleases(project.root)).filter((r) => !options.ids || options.ids.some((id) => r.id.startsWith(id)));
  const out: VerifyResult[] = [];
  for (const release of releases) {
    if (!release.baseline) continue;
    const day = options.force ? releaseAge(release, now) : dueMilestone(release, now);
    if (day === null) continue;
    const appId = ids[release.store];
    if (!appId) continue;
    const current: RankSnapshot = {};
    for (const [country, ranks] of Object.entries(release.baseline.ranks)) {
      try {
        current[country] = await source.ranks(release.store, appId, country, Object.keys(ranks));
      } catch {
        // leave the storefront out of this check
      }
    }
    const span = Math.min(Math.max(day, 1), 14);
    const metrics = options.metrics ? await measureAround(options.metrics, release.store, appId, release.pushedAt, span).catch(() => null) : null;
    const conversion = options.conversion
      ? await measureConversion(options.conversion, release.store, appId, release.pushedAt, span).catch(() => null)
      : metrics
        ? conversionFromMetrics(metrics)
        : null;
    const evaluation = evaluateRanks(release.baseline.ranks, current);
    // Unchanged storefronts as a control: a store-wide lift is not the release's win.
    const control = compareWithControl(project, release, release.baseline.ranks, current);
    if (control) {
      evaluation.control = control;
      if (evaluation.verdict === "won" && control.net < MIN_NET_PLACES) {
        evaluation.verdict = "mixed";
        evaluation.note = `the unchanged storefronts (${control.control.join(", ")}) moved as much: the store moved, not the listing`;
      }
    }
    // Ranks are a means; when none moved, organic installs and revenue (or conversion) decide.
    const byOutcome = evaluation.verdict === "flat" && metrics ? outcomeVerdict(metrics.changes) : null;
    if (byOutcome) Object.assign(evaluation, { verdict: byOutcome.verdict, decidedBy: byOutcome.by });
    const check = {
      at: now.toISOString(),
      day,
      ranks: current,
      ...evaluation,
      ...(conversion ? { conversion } : {}),
      ...(metrics ? { metrics } : {}),
    };
    release.checks = [...(release.checks ?? []).filter((c) => c.day !== day), check].sort((a, b) => a.day - b.day);
    await updateRelease(project.root, release);
    out.push({ release, check });
  }
  return out;
}

/** The conversion field of a check, from outcome metrics when no conversion source is given. */
function conversionFromMetrics(m: NonNullable<Awaited<ReturnType<typeof measureAround>>>) {
  const window = (w: typeof m.before): ConversionWindow | null => {
    const rate = w.values.conversion;
    const views = w.values.page_views;
    if (rate === undefined || views === undefined) return null;
    const visitors = Math.round(views * w.days);
    return { rate, visitors, installs: Math.round(rate * visitors), days: w.days };
  };
  const before = window(m.before);
  const after = window(m.after);
  return before && after ? { before, after, change: before.rate > 0 ? after.rate / before.rate - 1 : 0 } : null;
}

/** One playbook line: what changed, the hypothesis, and what the ranks did. */
export function playbookLine(result: VerifyResult): string {
  const { release, check } = result;
  const fields = [...new Set(release.changes.map((c) => `${c.locale} ${c.field}`))].join(", ");
  const moves = [
    ...check.improved.slice(0, 3).map((m) => `"${m.keyword}" ${m.before ?? "–"}→${m.after ?? "–"}`),
    ...check.regressions.slice(0, 3).map((m) => `lost "${m.keyword}" ${m.before}→${m.after ?? "out"}`),
  ].join("; ");
  // Conversion and the money metrics say whether the listing sold better, not just ranked better.
  const outcomes = (check.metrics?.changes ?? []).filter((m) => m.outcome !== "flat" && ["conversion", "downloads", "revenue", "proceeds", "trials", "rc_trials", "organic_installs", "organic_revenue"].includes(m.metric));
  // The metrics that decided the verdict go first.
  if (check.decidedBy) outcomes.sort((a, b) => Number(check.decidedBy!.includes(b.metric)) - Number(check.decidedBy!.includes(a.metric)));
  const conv = outcomes.length
    ? outcomes.slice(0, 3).map((m) => formatChange(m, check.metrics?.after.currency)).join("; ")
    : check.conversion
      ? `conversion ${(check.conversion.before.rate * 100).toFixed(1)}% → ${(check.conversion.after.rate * 100).toFixed(1)}%`
      : "";
  const control = check.control ? `net ${check.control.net > 0 ? "+" : ""}${check.control.net} places vs unchanged ${check.control.control.join(", ")}` : "";
  const detail = [moves, control, conv].filter(Boolean).join("; ");
  return `- ${release.pushedAt.slice(0, 10)}, ${release.store}, ${fields}${release.note ? `: ${release.note}` : ""} → day ${check.day} ${check.verdict}${check.decidedBy ? " by outcomes" : ""}${detail ? ` (${detail})` : ""}`;
}

/** Append lines to appeeky/playbook.md, skipping ones already there. */
export async function appendPlaybook(root: string, lines: string[]): Promise<number> {
  const file = join(root, SPEC_DIR, "playbook.md");
  const existing = existsSync(file) ? await readFile(file, "utf8") : "# Playbook\n";
  const fresh = lines.filter((l) => !existing.includes(l));
  if (fresh.length === 0) return 0;
  if (!existsSync(file)) await writeFile(file, existing);
  await appendFile(file, `${existing.endsWith("\n") ? "" : "\n"}${fresh.join("\n")}\n`);
  return fresh.length;
}

/** The app an experiment is about: its store, or the first store in the spec. */
export function experimentApp(project: Project, e: Pick<Experiment, "store">): { store: StoreId; appId: string } | null {
  const ids = rankAppIds(project);
  const store = e.store ?? (Object.keys(ids)[0] as StoreId | undefined);
  const appId = store ? ids[store] : undefined;
  return store && appId ? { store, appId } : null;
}

/**
 * Close due experiments whose metric Appeeky can measure (conversion, revenue,
 * trials, cpa, ...): the value is the metric over the experiment's run.
 * Experiments on other metrics stay due for `experiment close --value`.
 */
export async function measureExperiments(project: Project, source: MetricSource, now = new Date()): Promise<Experiment[]> {
  const closed: Experiment[] = [];
  for (const e of dueExperiments(await readExperiments(project.root), now)) {
    if (!isMetricName(e.metric)) continue;
    const app = experimentApp(project, e);
    if (!app) continue;
    const value = await metricAfter(source, app.store, app.appId, e.metric, e.startedAt, e.checkAfterDays).catch(() => undefined);
    if (value === undefined) continue;
    closed.push(await writeExperiment(project.root, closeExperiment(e, value, `Measured by appeeky-spec over ${e.checkAfterDays} days.`, now)));
  }
  return closed;
}
