import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { projectCoverage, type StorefrontCoverage } from "./coverage.js";
import { diffListings } from "./diff.js";
import { loadProject, SPEC_DIR, SPEC_FILE } from "./files.js";
import { lintProject } from "./lint.js";
import { STORES, type Listing, type Project, type StoreListings } from "./schema.js";

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
export function specReport(base: Project | null, head: Project): string {
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

  const issues = lintProject(head).filter((i) => i.severity !== "info");
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
