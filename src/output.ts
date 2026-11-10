import type { StorefrontCoverage } from "./coverage.js";
import type { Issue } from "./lint.js";
import type { FieldChange } from "./stores/types.js";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36),
  badge: (s: string) => badge(s),
};

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const STORE_LABEL = { "app-store": "App Store", "google-play": "Google Play" } as const;
export const storeLabel = (s: keyof typeof STORE_LABEL) => STORE_LABEL[s];

export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return c.green("No issues.");
  const icon = { error: c.red("error"), warning: c.yellow("warn "), info: c.cyan("info ") };
  return issues
    .map((i) => `${icon[i.severity]}  ${c.dim(`${storeLabel(i.store)} ${i.locale}${i.field ? ` ${i.field}` : ""}`)}  ${i.message} ${c.dim(`(${i.rule})`)}`)
    .join("\n");
}

function preview(value: string | undefined, width = 70): string {
  if (value === undefined) return c.dim("(empty)");
  const flat = value.replace(/\n+/g, " ⏎ ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

export function formatChanges(changes: FieldChange[]): string {
  if (changes.length === 0) return c.green("In sync with the store.");
  const lines: string[] = [];
  let last = "";
  for (const ch of changes) {
    const head = `${storeLabel(ch.store)} ${ch.locale}${ch.newLocale ? c.yellow(" (new locale)") : ""}`;
    if (head !== last) {
      lines.push(c.bold(head));
      last = head;
    }
    lines.push(`  ${ch.field}`);
    lines.push(`    ${c.red("-")} ${preview(ch.before)}`);
    lines.push(`    ${c.green("+")} ${preview(ch.after)}`);
    if (ch.blocked) lines.push(`    ${c.yellow("blocked:")} ${ch.blocked}`);
  }
  return lines.join("\n");
}

const LEVEL_LABEL: Record<string, string> = {
  title: "in title",
  subtitle: "name+subtitle",
  short: "short desc",
  full: "indexed",
  split: "split locales",
  partial: "partial",
  none: "missing",
};

export function formatCoverage(reports: StorefrontCoverage[]): string {
  if (reports.length === 0) return c.dim("No targets yet. Add keywords under `targets:` in appeeky.spec.yaml.");
  const out: string[] = [];
  for (const r of reports) {
    const weighted = r.weightedPercent !== undefined ? `, ${r.weightedPercent}% by popularity` : "";
    out.push(
      c.bold(`${storeLabel(r.store)} ${r.country.toUpperCase()}`) +
        c.dim(` (${r.locales.join(", ") || "no listing"})`) +
        `  ${r.covered}/${r.total} covered (${r.percent}%${weighted})`,
    );
    const rows = [...r.keywords].sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));
    for (const k of rows) {
      const ok = ["title", "subtitle", "short", "full"].includes(k.level);
      const mark = ok ? c.green("✓") : k.level === "none" ? c.red("✗") : c.yellow("~");
      const pop = k.popularity !== undefined ? c.dim(` pop ${String(k.popularity).padStart(3)} diff ${String(k.difficulty ?? "-").padStart(3)}`) : "";
      const missing = k.missing.length > 0 ? c.dim(`  missing: ${k.missing.join(", ")}`) : "";
      out.push(`  ${mark} ${k.keyword.padEnd(28)} ${LEVEL_LABEL[k.level]!.padEnd(14)}${pop}${missing}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Show a spinner while `task` runs, in a terminal only. Lines the task logs print above the
 * spinner, so a command that reports as it goes still reads cleanly. Never wrap a prompt.
 */
export async function spin<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY || process.env.CI) return task();
  let i = 0;
  const draw = () => process.stdout.write(`\r\u001b[2K  ${c.cyan(FRAMES[i++ % FRAMES.length]!)} ${c.dim(label)}`);
  const clear = () => process.stdout.write("\r\u001b[2K");
  const log = console.log;
  console.log = (...args: unknown[]) => {
    clear();
    log(...args);
    draw();
  };
  draw();
  const timer = setInterval(draw, 80);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    console.log = log;
    clear();
  }
}

/** White on cyan, for the setup's title. */
export const badge = (s: string) => (useColor ? `\u001b[46m\u001b[30m${s}\u001b[0m` : s);
