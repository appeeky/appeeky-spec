import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { projectCoverage, type StorefrontCoverage } from "./coverage.js";
import { diffListings } from "./diff.js";
import { loadProject, SPEC_DIR, SPEC_FILE } from "./files.js";
import { lintProject, type Issue } from "./lint.js";
import { STORES, type Listing, type Project, type StoreListings } from "./schema.js";
import { draftIssues, readAccounts, readDrafts } from "./social.js";
import { readBriefs } from "./ugc.js";
import { readReplies, replyIssues } from "./reviews.js";

const run = promisify(execFile);

/** Load the spec as it was at a git ref (e.g. `origin/main`), or null when it did not exist there. */
export async function loadProjectAtRef(root: string, ref: string): Promise<Project | null> {
  const { stdout: top } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  const prefix = relative(await realpath(top.trim()), await realpath(root));
  const paths = [SPEC_FILE, SPEC_DIR].map((p) => (prefix ? `${prefix}/${p}` : p));
  const dir = await mkdtemp(join(tmpdir(), "appeeky-spec-base-"));
  try {
    const archive = await run("git", ["archive", "--format=tar", ref, "--", ...paths], { cwd: top.trim(), encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }).catch(() => null);
    if (!archive) return null;
    await new Promise<void>((resolve, reject) => {
      const tar = execFile("tar", ["-x", "-C", dir], (err) => (err ? reject(err) : resolve()));
      tar.stdin!.end(archive.stdout);
    });
    return await loadProject(join(dir, prefix));
  } catch {
    return null;
  } finally {
    // loadProject read everything into memory; the copy is no longer needed.
    await rm(dir, { recursive: true, force: true });
  }
}

const key = (r: StorefrontCoverage) => `${r.store}:${r.country}`;
const label = (r: StorefrontCoverage) => `${r.store === "app-store" ? "App Store" : "Google Play"} ${r.country.toUpperCase()}`;

/** Markdown for a pull request: listing changes, check results and coverage before → after. */
/** `screenshots`: issues from `checkScreenshots`, reported with the listing check. */
export function specReport(base: Project | null, head: Project, screenshots: Issue[] = []): string {
  const out: string[] = ["## Appeeky Spec"];

  const changes = STORES.flatMap((store) =>
    diffListings(store, head.listings[store] as StoreListings<Listing>, (base?.listings[store] ?? {}) as StoreListings<Listing>),
  );
  out.push("", `**${changes.length} listing field${changes.length === 1 ? "" : "s"} changed**`);
  if (changes.length > 0) {
    out.push("", "| Store | Locale | Field | After |", "| --- | --- | --- | --- |");
    for (const c of changes.slice(0, 40)) {
      out.push(`| ${c.store} | ${c.locale} | ${c.field} | ${c.after.replace(/\n+/g, " ").replace(/\|/g, "\\|").slice(0, 90)} |`);
    }
  }

  const issues = [...lintProject(head), ...screenshots].filter((i) => i.severity !== "info");
  const errors = issues.filter((i) => i.severity === "error").length;
  out.push("", `**Check:** ${errors} error${errors === 1 ? "" : "s"}, ${issues.length - errors} warning${issues.length - errors === 1 ? "" : "s"}`);
  for (const i of issues.slice(0, 20)) out.push(`- ${i.severity === "error" ? "❌" : "⚠️"} ${i.store} ${i.locale}${i.field ? ` ${i.field}` : ""}: ${i.message}`);

  const before = new Map((base ? projectCoverage(base) : []).map((r) => [key(r), r]));
  const after = projectCoverage(head);
  if (after.length > 0) {
    out.push("", "| Storefront | Coverage | Gained | Lost |", "| --- | --- | --- | --- |");
    for (const r of after) {
      const b = before.get(key(r));
      const covered = (x?: StorefrontCoverage) => new Set((x?.keywords ?? []).filter((k) => ["title", "subtitle", "short", "full"].includes(k.level)).map((k) => k.keyword));
      const was = covered(b);
      const now = covered(r);
      const gained = [...now].filter((k) => !was.has(k));
      const lost = [...was].filter((k) => !now.has(k));
      const pct = b ? `${b.percent}% → ${r.percent}%` : `${r.percent}%`;
      out.push(`| ${label(r)} | ${pct} | ${gained.join(", ") || "—"} | ${lost.length > 0 ? `**${lost.join(", ")}**` : "—"} |`);
    }
  }
  return out.join("\n");
}

const cell = (s: string, n = 90) => s.replace(/\n+/g, " ").replace(/\|/g, "\\|").slice(0, n);

/**
 * What a merge sends out: review replies, social drafts and UGC briefs still marked draft, so a
 * reviewer sees them next to the listing change. Empty when there are none.
 */
export async function outboxReport(root: string, now = new Date()): Promise<string> {
  const out: string[] = [];
  const rel = (f: string) => relative(root, f);
  try {
    const replies = (await readReplies(root)).filter((r) => r.status === "draft");
    if (replies.length > 0) {
      out.push("", `**${replies.length} review repl${replies.length === 1 ? "y goes" : "ies go"} out on merge**`, "", "| Reply | Store | Review | Text |", "| --- | --- | --- | --- |");
      for (const r of replies) out.push(`| ${rel(r.file)} | ${r.store} | ${cell(r.review ?? "", 60)} | ${cell(r.text)} |`);
      for (const r of replies) for (const issue of replyIssues(r)) out.push(`- ⚠️ ${rel(r.file)}: too long, ${issue}`);
    }
  } catch (err) {
    out.push("", `- ❌ Review replies: ${(err as Error).message}`);
  }
  try {
    const drafts = (await readDrafts(root)).filter((d) => d.status === "draft");
    if (drafts.length > 0) {
      const accounts = await readAccounts(root);
      out.push("", `**${drafts.length} post${drafts.length === 1 ? " goes" : "s go"} out on merge**`, "", "| Draft | Accounts | When | Text |", "| --- | --- | --- | --- |");
      for (const d of drafts) out.push(`| ${rel(d.file)} | ${d.accounts.join(", ")} | ${d.when ?? "on merge"} | ${cell(d.text)} |`);
      if (accounts.length === 0) out.push("", "- ⚠️ No accounts in appeeky/social/accounts.yaml: run `social pull` so the drafts can be checked.");
      else for (const d of drafts) for (const issue of draftIssues(d, accounts, now)) out.push(`- ⚠️ ${rel(d.file)}: ${issue}`);
    }
  } catch (err) {
    out.push("", `- ❌ Social drafts: ${(err as Error).message}`);
  }
  try {
    const briefs = (await readBriefs(root)).filter((b) => b.status === "draft");
    if (briefs.length > 0) {
      out.push("", `**${briefs.length} clip${briefs.length === 1 ? "" : "s"} made on merge**`, "", "| Brief | Persona | Length | Script |", "| --- | --- | --- | --- |");
      for (const b of briefs) out.push(`| ${rel(b.file)} | ${b.persona} | ${b.durationSec ?? 8}s ${b.aspectRatio ?? "9:16"} | ${cell(b.script)} |`);
      out.push("", "Run `ugc generate --dry-run` (or `--local --dry-run`) for the cost.");
    }
  } catch (err) {
    out.push("", `- ❌ UGC briefs: ${(err as Error).message}`);
  }
  return out.join("\n");
}
