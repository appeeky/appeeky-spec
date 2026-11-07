// Pure helpers for scripts/release.mjs: decide the next version from
// Conventional Commits and write the changelog section.

/** @typedef {{ hash: string, subject: string, body: string }} Commit */
/** @typedef {"major" | "minor" | "patch"} Bump */

const HEADER = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;

/** Parses a Conventional Commit; returns undefined for anything else (merges, plain messages). */
export function parseCommit(commit) {
  const match = HEADER.exec(commit.subject);
  if (!match) return undefined;
  const [, type, scope, bang, description] = match;
  const breaking = Boolean(bang) || /^BREAKING[ -]CHANGE:/m.test(commit.body);
  return { ...commit, type, scope: scope?.slice(1, -1), breaking, description };
}

const isReleaseCommit = (parsed) => parsed.type === "chore" && parsed.scope === "release";

/** The bump a list of commits asks for, or undefined when none of them is releasable. */
export function bumpFor(commits) {
  let bump;
  for (const commit of commits) {
    const parsed = parseCommit(commit);
    if (!parsed || isReleaseCommit(parsed)) continue;
    if (parsed.breaking) return "major";
    if (parsed.type === "feat") bump = "minor";
    else if ((parsed.type === "fix" || parsed.type === "perf") && bump !== "minor") bump = "patch";
  }
  return bump;
}

/** Applies a bump. While the major version is 0, a breaking change bumps the minor version. */
export function nextVersion(current, bump) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "major") return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Changelog lines for the commits: breaking changes, features and fixes, each linked to its commit. */
export function renderCommits(commits, repoUrl) {
  const groups = { breaking: [], feat: [], fix: [] };
  for (const commit of commits) {
    const parsed = parseCommit(commit);
    if (!parsed || isReleaseCommit(parsed)) continue;
    const line = `- ${parsed.scope ? `**${parsed.scope}:** ` : ""}${parsed.description} ([${parsed.hash.slice(0, 7)}](${repoUrl}/commit/${parsed.hash}))`;
    if (parsed.breaking) groups.breaking.push(line);
    else if (parsed.type === "feat") groups.feat.push(line);
    else if (parsed.type === "fix" || parsed.type === "perf") groups.fix.push(line);
  }
  const parts = [];
  if (groups.breaking.length) parts.push(`### Breaking changes\n\n${groups.breaking.join("\n")}`);
  if (groups.feat.length) parts.push(`### Features\n\n${groups.feat.join("\n")}`);
  if (groups.fix.length) parts.push(`### Fixes\n\n${groups.fix.join("\n")}`);
  return parts.join("\n\n");
}

const UNRELEASED = /^## Unreleased[^\n]*\n/m;

/**
 * Writes the release into the changelog and returns it with the notes for the GitHub release.
 * Notes written by hand under "## Unreleased" become the release section. Without them, the
 * section lists the commits.
 */
export function releaseChangelog(changelog, version, date, commitNotes) {
  const heading = `## ${version} (${date})`;
  const match = UNRELEASED.exec(changelog);
  if (match) {
    const start = match.index + match[0].length;
    const next = changelog.slice(start).search(/^## /m);
    const end = next === -1 ? changelog.length : start + next;
    const written = changelog.slice(start, end).trim();
    if (written) {
      return {
        changelog: `${changelog.slice(0, match.index)}${heading}\n\n${written}\n${end < changelog.length ? `\n${changelog.slice(end)}` : ""}`,
        notes: written,
      };
    }
    changelog = `${changelog.slice(0, match.index)}${changelog.slice(end)}`;
  }
  const notes = commitNotes.trim();
  const section = `${heading}\n\n${notes || "Maintenance release."}\n`;
  const first = changelog.search(/^## /m);
  return {
    changelog: first === -1 ? `${changelog.trimEnd()}\n\n${section}` : `${changelog.slice(0, first)}${section}\n${changelog.slice(first)}`,
    notes: notes || "Maintenance release.",
  };
}
