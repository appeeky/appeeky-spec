import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readChanges } from "./competitors.js";
import { readExperiments, type Experiment } from "./experiments.js";
import { SPEC_DIR } from "./files.js";
import { readReleases, releaseAge, type ReleaseRecord } from "./history.js";
import { CHECK_DAYS } from "./measure.js";
import { formatChange, METRICS, type MetricName } from "./metrics.js";
import type { StoreId } from "./schema.js";

/**
 * Every measurement loop in the repo, in one place: each listing push (a release) and each
 * experiment, what it measures, when it is checked next and what it shows so far. Written to
 * appeeky/loops.md by the commands that open, measure or close a loop, and shown by `status`.
 */

const DAY = 86_400_000;
/** A check this many days past its date with no result has stalled (CI not running, a key missing). */
export const LATE_AFTER_DAYS = 2;
/** Fewer installs than this in a window: the numbers are a hint, not a result. */
export const FEW_INSTALLS = 100;

export type LoopState = "measuring" | "due" | "late" | "closed";

export interface Loop {
  kind: "release" | "experiment";
  id: string;
  store?: StoreId;
  /** What changed, or the hypothesis. */
  what: string;
  /** What decides it. */
  metric: string;
  startedAt: string;
  /** Next check date (YYYY-MM-DD), none once closed. */
  nextCheck?: string;
  state: LoopState;
  /** The latest result: "day 7 won", "won (12 ≥ 10)". */
  result?: string;
  /** The numbers behind the latest result. */
  detail?: string[];
  warnings: string[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function stateFor(nextCheckMs: number | undefined, now: Date): LoopState {
  if (nextCheckMs === undefined) return "closed";
  if (now.getTime() < nextCheckMs) return "measuring";
  return now.getTime() >= nextCheckMs + LATE_AFTER_DAYS * DAY ? "late" : "due";
}

function releaseWhat(r: ReleaseRecord): string {
  const fields = [...new Set(r.changes.map((c) => `${c.locale} ${c.field}`))];
  const head = fields.slice(0, 3).join(", ") + (fields.length > 3 ? ` +${fields.length - 3}` : "");
  return r.note ? `${head}: ${r.note}` : head || r.target;
}

/** Installs per window behind a release's latest check, when it has them. */
function windowInstalls(check: NonNullable<ReleaseRecord["checks"]>[number]): number | undefined {
  const m = check.metrics;
  if (!m) return undefined;
  const per = (w: typeof m.before) => (w.values.organic_installs ?? w.values.downloads) as number | undefined;
  const b = per(m.before);
  const a = per(m.after);
  if (b === undefined || a === undefined) return undefined;
  return Math.round(Math.min(b * m.before.days, a * m.after.days));
}

export function releaseLoop(r: ReleaseRecord, now = new Date()): Loop {
  const done = new Set((r.checks ?? []).map((c) => c.day));
  const next = r.baseline ? CHECK_DAYS.find((d) => !done.has(d)) : undefined;
  const nextMs = next === undefined ? undefined : Date.parse(r.pushedAt) + next * DAY;
  const last = r.checks?.at(-1);
  const warnings: string[] = [];
  if (!r.baseline) warnings.push("no baseline was saved at push: it cannot be measured");
  const installs = last ? windowInstalls(last) : undefined;
  if (installs !== undefined && installs < FEW_INSTALLS) warnings.push(`${installs} installs in the window: treat the result as a hint`);
  return {
    kind: "release",
    id: r.id,
    store: r.store,
    what: releaseWhat(r),
    metric: last?.decidedBy ? last.decidedBy.map((m) => METRICS[m as MetricName]?.label ?? m).join(", ") : "target ranks",
    startedAt: r.pushedAt,
    ...(nextMs !== undefined ? { nextCheck: iso(nextMs) } : {}),
    state: r.baseline ? stateFor(nextMs, now) : "closed",
    ...(last ? { result: `day ${last.day} ${last.verdict}${last.decidedBy ? " by outcomes" : ""}` } : {}),
    ...(last
      ? {
          detail: [
            ...(last.improved.length || last.dropped.length ? [`${last.improved.length} ${last.improved.length === 1 ? "target" : "targets"} up, ${last.dropped.length} down`] : []),
            ...(last.control ? [`net ${last.control.net > 0 ? "+" : ""}${last.control.net} places vs unchanged storefronts`] : []),
            ...(last.note ? [last.note] : []),
            ...(last.metrics?.changes ?? []).filter((c) => c.outcome !== "flat").slice(0, 3).map((c) => formatChange(c, last.metrics?.after.currency)),
          ],
        }
      : {}),
    warnings,
  };
}

export function experimentLoop(e: Experiment, now = new Date()): Loop {
  const running = e.status === "running";
  const nextMs = running ? Date.parse(e.startedAt) + e.checkAfterDays * DAY : undefined;
  const value = e.result?.value;
  const goal = e.target !== undefined ? `target ${e.target}` : e.baseline !== undefined ? `baseline ${round(e.baseline)}` : "";
  return {
    kind: "experiment",
    id: e.id,
    ...(e.store ? { store: e.store } : {}),
    what: e.hypothesis,
    metric: METRICS[e.metric as MetricName]?.label ?? e.metric,
    startedAt: e.startedAt,
    ...(nextMs !== undefined ? { nextCheck: iso(nextMs) } : {}),
    state: stateFor(nextMs, now),
    ...(running ? {} : { result: `${e.status}${value !== undefined ? ` (${round(value)}${goal ? ` vs ${goal}` : ""})` : ""}` }),
    ...(running && goal ? { detail: [goal] } : {}),
    warnings: [],
  };
}

const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 1000) / 1000);

/**
 * Releases on the same store pushed within the measuring span of each other are measured
 * over the same days, so their results mix. Both get a warning while either is open.
 */
function markOverlaps(releases: ReleaseRecord[], loops: Map<string, Loop>): void {
  const span = Math.max(...CHECK_DAYS) * DAY;
  for (const a of releases)
    for (const b of releases) {
      if (a.id >= b.id || a.store !== b.store) continue;
      if (Math.abs(Date.parse(a.pushedAt) - Date.parse(b.pushedAt)) >= span) continue;
      const la = loops.get(a.id)!;
      const lb = loops.get(b.id)!;
      if (la.state === "closed" && lb.state === "closed") continue;
      la.warnings.push(`measured over the same days as ${b.id}: the results mix`);
      lb.warnings.push(`measured over the same days as ${a.id}: the results mix`);
    }
}

const ORDER: Record<LoopState, number> = { late: 0, due: 1, measuring: 2, closed: 3 };

export async function collectLoops(root: string, now = new Date()): Promise<Loop[]> {
  const releases = await readReleases(root);
  const experiments = await readExperiments(root);
  const byId = new Map<string, Loop>();
  for (const r of releases) byId.set(r.id, releaseLoop(r, now));
  markOverlaps(releases, byId);
  // A competitor's change inside a release's window moves the same numbers.
  const changes = await readChanges(root);
  const span = Math.max(...CHECK_DAYS) * DAY;
  for (const r of releases) {
    const loop = byId.get(r.id)!;
    if (loop.state === "closed") continue;
    const from = Date.parse(r.pushedAt) - span;
    const to = Date.parse(r.pushedAt) + span;
    for (const ch of changes) {
      const t = Date.parse(ch.date);
      if (t >= from && t <= to && (ch.change.startsWith(r.store === "app-store" ? "App Store" : "Google Play"))) loop.warnings.push(`${ch.name} changed on ${ch.date}, inside this window: ${ch.change}`);
    }
  }
  const loops = [...byId.values(), ...experiments.map((e) => experimentLoop(e, now))];
  return loops.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.nextCheck ?? "9").localeCompare(b.nextCheck ?? "9") || b.startedAt.localeCompare(a.startedAt));
}

const STATE_LABEL: Record<LoopState, string> = { late: "late", due: "due", measuring: "measuring", closed: "closed" };

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");

/** appeeky/loops.md: what is being measured, what is due, what came out. Rewritten, not appended. */
export function loopsMarkdown(loops: Loop[], now = new Date()): string {
  const open = loops.filter((l) => l.state !== "closed");
  const closed = loops.filter((l) => l.state === "closed").slice(0, 20);
  const lines = [
    "# Loops",
    "",
    `Every change being measured, generated by appeeky-spec on ${iso(now.getTime())}. Do not edit: run \`appeeky-spec status\`.`,
    "Releases are checked on day 7 and day 14 (`verify`); experiments on their check date (`verify`, `experiment close`).",
    "",
    "## Open",
    "",
  ];
  if (open.length === 0) lines.push("Nothing is being measured.");
  else {
    lines.push("| State | Next check | Kind | What | Decided by | So far |", "| --- | --- | --- | --- | --- | --- |");
    for (const l of open)
      lines.push(
        `| ${STATE_LABEL[l.state]} | ${l.nextCheck ?? "—"} | ${l.kind}${l.store ? ` · ${l.store}` : ""} | ${cell(l.what)} | ${cell(l.metric)} | ${cell([l.result, ...(l.detail ?? [])].filter(Boolean).join("; ") || "—")} |`,
      );
  }
  const warned = loops.filter((l) => l.warnings.length && l.state !== "closed");
  if (warned.length) {
    lines.push("", "## Watch", "");
    for (const l of warned) for (const w of l.warnings) lines.push(`- \`${l.id}\`: ${w}`);
  }
  lines.push("", "## Closed", "");
  if (closed.length === 0) lines.push("Nothing closed yet.");
  else {
    lines.push("| Closed loop | What | Result |", "| --- | --- | --- |");
    for (const l of closed) lines.push(`| \`${l.id}\` | ${cell(l.what)} | ${cell([l.result, ...(l.detail ?? [])].filter(Boolean).join("; ") || "—")} |`);
  }
  return lines.join("\n") + "\n";
}

export async function writeLoops(root: string, now = new Date()): Promise<Loop[]> {
  const loops = await collectLoops(root, now);
  await mkdir(join(root, SPEC_DIR), { recursive: true });
  await writeFile(join(root, SPEC_DIR, "loops.md"), loopsMarkdown(loops, now));
  return loops;
}

/**
 * Stores with no release being measured: a new listing change there will not mix with an
 * open one. This is what a scheduled agent checks before it proposes anything.
 */
export function freeStores(loops: Loop[], stores: StoreId[]): StoreId[] {
  const busy = new Set(loops.filter((l) => l.kind === "release" && l.state !== "closed").map((l) => l.store));
  return stores.filter((s) => !busy.has(s));
}

