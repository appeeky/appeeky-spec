import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { SPEC_DIR } from "./files.js";
import type { StoreId } from "./schema.js";
import type { FieldChange } from "./stores/types.js";
import { formatChange, type MetricsCheck } from "./metrics.js";
import type { ConversionChange, RankEvaluation, RankSnapshot } from "./verify.js";

/**
 * Every push writes a release record to `appeeky/releases/`. It is the
 * history of what went live and when, the input for measuring impact later,
 * and what a revert pushes back.
 */
export interface ReleaseRecord {
  id: string;
  pushedAt: string;
  store: StoreId;
  /** Where it went, e.g. "version 2.4 (prepare for submission)". */
  target: string;
  via: string;
  /** Free-text reason or hypothesis, from `push --note`. */
  note?: string;
  changes: Array<Pick<FieldChange, "locale" | "field" | "before" | "after">>;
  /** Search ranks of the targets right before the push. */
  baseline?: { at: string; source: string; ranks: RankSnapshot };
  /** Rank checks after the push (`appeeky-spec verify`). */
  checks?: Array<{ at: string; day: number; ranks: RankSnapshot; conversion?: ConversionChange; metrics?: MetricsCheck } & RankEvaluation>;
}

/** Days since a release went out. */
export function releaseAge(record: ReleaseRecord, now = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(record.pushedAt)) / 86_400_000);
}

/** Markdown summary of a release: for PR descriptions, changelogs and team updates. */
export function releaseMarkdown(record: ReleaseRecord): string {
  const lines = [`### ${record.store === "app-store" ? "App Store" : "Google Play"} · ${record.target}`];
  if (record.note) lines.push("", `> ${record.note}`);
  lines.push("", "| Locale | Field | Before | After |", "| --- | --- | --- | --- |");
  const cell = (v?: string) => (v ?? "").replace(/\n+/g, " ").replace(/\|/g, "\\|").slice(0, 80) || "—";
  for (const c of record.changes) lines.push(`| ${c.locale} | ${c.field} | ${cell(c.before)} | ${cell(c.after)} |`);
  const last = record.checks?.at(-1);
  if (last) {
    const conv = last.conversion ? `, conversion ${(last.conversion.before.rate * 100).toFixed(1)}% → ${(last.conversion.after.rate * 100).toFixed(1)}%` : "";
    lines.push("", `Day ${last.day}: **${last.verdict}** (${last.improved.length} up, ${last.dropped.length} down, ${last.regressions.length} top-20 lost${conv})`);
    for (const m of last.metrics?.changes ?? []) lines.push(`- ${formatChange(m, last.metrics?.after.currency)}`);
  }
  return lines.join("\n");
}

export function releasesDir(root: string): string {
  return join(root, SPEC_DIR, "releases");
}

export function releaseId(date: Date, store: StoreId): string {
  return `${date.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z")}-${store}`;
}

export async function writeRelease(root: string, record: ReleaseRecord): Promise<string> {
  const dir = releasesDir(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${record.id}.yaml`);
  await writeFile(file, YAML.stringify(record, { lineWidth: 0, blockQuote: "literal" }));
  return file;
}

export async function updateRelease(root: string, record: ReleaseRecord): Promise<void> {
  await writeFile(join(releasesDir(root), `${record.id}.yaml`), YAML.stringify(record, { lineWidth: 0, blockQuote: "literal" }));
}

export async function readReleases(root: string): Promise<ReleaseRecord[]> {
  const dir = releasesDir(root);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort().reverse();
  const out: ReleaseRecord[] = [];
  for (const f of files) out.push(YAML.parse(await readFile(join(dir, f), "utf8")) as ReleaseRecord);
  return out;
}
