import { describe, expect, it } from "vitest";
import { bumpFor, nextVersion, releaseChangelog, renderCommits } from "./release-lib.mjs";

const commit = (subject, body = "") => ({ hash: "a1b2c3d4e5f6", subject, body });

describe("bumpFor", () => {
  it("takes the largest bump the commits ask for", () => {
    expect(bumpFor([commit("fix: a"), commit("feat: b")])).toBe("minor");
    expect(bumpFor([commit("perf: a"), commit("docs: b")])).toBe("patch");
    expect(bumpFor([commit("feat!: a")])).toBe("major");
    expect(bumpFor([commit("fix: a", "BREAKING CHANGE: gone")])).toBe("major");
  });

  it("releases nothing for docs, chores, merges and its own release commits", () => {
    expect(bumpFor([commit("docs: a"), commit("Merge pull request #1"), commit("chore(release): v0.2.0 [skip ci]")])).toBeUndefined();
  });
});

describe("nextVersion", () => {
  it("bumps the minor version for a breaking change while at 0.x", () => {
    expect(nextVersion("0.1.3", "major")).toBe("0.2.0");
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
    expect(nextVersion("0.1.3", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.3", "patch")).toBe("0.1.4");
  });
});

describe("releaseChangelog", () => {
  const commits = renderCommits([commit("feat(push): dry run"), commit("fix: tag")], "https://x");

  it("turns the notes under Unreleased into the release section", () => {
    const before = "# Changelog\n\n## Unreleased\n\n- Docker.\n\n## 0.1.0 (2026-11-01)\n\n- First.\n";
    const { changelog, notes } = releaseChangelog(before, "0.2.0", "2026-11-08", commits);
    expect(changelog).toBe("# Changelog\n\n## 0.2.0 (2026-11-08)\n\n- Docker.\n\n## 0.1.0 (2026-11-01)\n\n- First.\n");
    expect(notes).toBe("- Docker.");
  });

  it("lists the commits when nothing was written, and drops an empty Unreleased heading", () => {
    const before = "# Changelog\n\n## Unreleased\n\n## 0.1.0 (2026-11-01)\n\n- First.\n";
    const { changelog, notes } = releaseChangelog(before, "0.2.0", "2026-11-08", commits);
    expect(changelog).toBe(`# Changelog\n\n## 0.2.0 (2026-11-08)\n\n${commits}\n\n## 0.1.0 (2026-11-01)\n\n- First.\n`);
    expect(notes).toContain("**push:** dry run ([a1b2c3d](https://x/commit/a1b2c3d4e5f6))");
    expect(notes).toContain("### Fixes");
  });

  it("releases the only section of a first changelog", () => {
    const { changelog } = releaseChangelog("# Changelog\n\n## Unreleased\n\n- All of it.\n", "0.1.0", "2026-11-08", "");
    expect(changelog).toBe("# Changelog\n\n## 0.1.0 (2026-11-08)\n\n- All of it.\n");
  });
});
