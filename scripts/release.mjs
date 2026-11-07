#!/usr/bin/env node
// Releases @appeeky/spec when commits since the last tag ask for it.
// Run by CI on main after the tests pass. Locally, `npm run release:dry` prints the plan.
//
// 1. Find the last v* tag. Without one, release the version in package.json as is.
// 2. Decide the bump from Conventional Commits since that tag (feat: minor,
//    fix/perf: patch, breaking: major, or minor while at 0.x). No bump, no release.
// 3. Set the version, refresh the lockfile, and turn "## Unreleased" in CHANGELOG.md
//    into the release section (or list the commits when nothing was written there).
// 4. Publish to npm unless npm already has that version.
// 5. Commit, tag v<version>, move the v<major> tag the GitHub Action is used by, push,
//    and create the GitHub release. The tag is written to $GITHUB_OUTPUT for the image build.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { bumpFor, nextVersion, releaseChangelog, renderCommits } from "./release-lib.mjs";

const REPO_URL = "https://github.com/appeeky/appeeky-spec";
const dryRun = process.argv.includes("--dry-run");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const run = (cmd, args) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (!dryRun) execFileSync(cmd, args, { stdio: "inherit" });
};

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const { name } = manifest;
const current = manifest.version;

// 1–2. The version
const lastTag = sh("git", ["tag", "--list", "v*.*.*", "--sort=-v:refname"]).split("\n").filter(Boolean)[0];
let version;
let commits = [];
if (!lastTag) {
  version = current;
  console.log(`No release tag yet: releasing ${version} as it is.`);
} else {
  const log = sh("git", ["log", `${lastTag}..HEAD`, "--format=%H%x1f%s%x1f%b%x1e"]);
  commits = log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, body = ""] = entry.split("\x1f");
      return { hash, subject, body };
    });
  const bump = bumpFor(commits);
  if (!bump) {
    console.log(`Nothing to release since ${lastTag}: no feat, fix, perf or breaking commits.`);
    process.exit(0);
  }
  version = nextVersion(lastTag.slice(1), bump);
  console.log(`${lastTag} -> v${version} (${bump}, ${commits.length} commits)`);
}

// 3. Version, lockfile, changelog
if (version !== current) {
  manifest.version = version;
  if (!dryRun) writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
}
const date = new Date().toISOString().slice(0, 10);
const { changelog, notes } = releaseChangelog(readFileSync("CHANGELOG.md", "utf8"), version, date, renderCommits(commits, REPO_URL));
if (!dryRun) writeFileSync("CHANGELOG.md", changelog);
console.log(`\n## ${version} (${date})\n\n${notes}\n`);

// 4. Publish unless npm has it (a rerun after a partial failure skips this).
// A brand-new package's metadata can take minutes to appear, but its tarball is
// served as soon as it is published, so check the tarball too.
const tarball = (ver) => `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${ver}.tgz`;
async function isPublished(ver) {
  try {
    if (sh("npm", ["view", `${name}@${ver}`, "version"], { stdio: ["ignore", "pipe", "ignore"] }) === ver) return true;
  } catch {
    // 404 from the metadata; fall through to the tarball
  }
  const res = await fetch(tarball(ver), { method: "HEAD" }).catch(() => undefined);
  return res?.ok ?? false;
}

/** npm takes a few minutes to serve a new version everywhere; the image build installs it right after. */
async function waitUntilDownloadable(ver, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(tarball(ver), { method: "HEAD" }).catch(() => undefined);
    if (res?.ok) return console.log(`${name}@${ver} is downloadable.`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  console.warn(`::warning::${name}@${ver} is not downloadable after ${timeoutMs / 60_000} minutes.`);
}

const provenance = process.env.NPM_PROVENANCE === "true" ? ["--provenance"] : [];
if (await isPublished(version)) console.log(`${name}@${version} is already on npm.`);
else run("npm", ["publish", "--access", "public", ...provenance]);
if (!dryRun) await waitUntilDownloadable(version);

// 5. Commit, tags, push, GitHub release
const tag = `v${version}`;
const major = `v${version.split(".")[0]}`;
run("git", ["add", "CHANGELOG.md", "package.json", "package-lock.json"]);
if (dryRun || sh("git", ["status", "--porcelain", "CHANGELOG.md", "package.json", "package-lock.json"])) {
  run("git", ["commit", "-m", `chore(release): ${tag} [skip ci]`]);
}
run("git", ["tag", tag]);
run("git", ["tag", "--force", major]);
run("git", ["push", "origin", "HEAD:main"]);
run("git", ["push", "origin", tag]);
run("git", ["push", "--force", "origin", major]);
run("gh", ["release", "create", tag, "--title", tag, "--notes", notes]);
if (process.env.GITHUB_OUTPUT && !dryRun) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
