import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeExperiment } from "./experiments.js";
import { writeRelease, type ReleaseRecord } from "./history.js";
import { collectLoops, experimentLoop, releaseLoop, writeLoops } from "./loops.js";

const now = new Date("2026-11-05T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

function release(id: string, pushedDaysAgo: number, extra: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    id,
    pushedAt: daysAgo(pushedDaysAgo),
    store: "app-store",
    target: "version 3.2",
    via: "test",
    note: "Lead with rain",
    changes: [{ locale: "en-US", field: "subtitle", before: "Calm", after: "Rain & fan" }],
    baseline: { at: daysAgo(pushedDaysAgo), source: "test", ranks: { us: { rain: 20 } } },
    ...extra,
  };
}

const check = (day: number, extra: object = {}) => ({ at: now.toISOString(), day, ranks: {}, improved: [], dropped: [], regressions: [], verdict: "won" as const, ...extra });

describe("release loops", () => {
  it("is measuring until day 7, due on it, late two days after", () => {
    expect(releaseLoop(release("a", 3), now)).toMatchObject({ state: "measuring", nextCheck: daysAgo(-4).slice(0, 10) });
    expect(releaseLoop(release("a", 7), now).state).toBe("due");
    expect(releaseLoop(release("a", 9), now).state).toBe("late");
  });
  it("moves on to day 14 after the day 7 check, and closes after it", () => {
    const r = release("a", 8, { checks: [check(7, { decidedBy: ["organic_installs"] })] });
    expect(releaseLoop(r, now)).toMatchObject({ state: "measuring", result: "day 7 won by outcomes", metric: "organic installs/day" });
    expect(releaseLoop(release("a", 15, { checks: [check(7), check(14)] }), now).state).toBe("closed");
  });
  it("warns when the window had few installs", () => {
    const metrics = {
      source: "test",
      before: { from: "", to: "", days: 7, values: { organic_installs: 4 } },
      after: { from: "", to: "", days: 7, values: { organic_installs: 6 } },
      changes: [{ metric: "organic_installs" as const, before: 4, after: 6, change: 0.5, outcome: "better" as const }],
    }
    const loop = releaseLoop(release("a", 8, { checks: [check(7, { metrics })] }), now);
    expect(loop.warnings).toEqual(["28 installs in the window: treat the result as a hint"]);
    expect(loop.detail).toEqual(["organic installs/day 4.0 → 6.0 (+50%)"]);
  });
});

describe("experiment loops", () => {
  const base = { id: "x", type: "ugc" as const, hypothesis: "Hooks get installs", metric: "link_installs", startedAt: daysAgo(3), checkAfterDays: 14, status: "running" as const, assets: [] };
  it("tracks the check date and closes with the value", () => {
    expect(experimentLoop({ ...base, target: 50 }, now)).toMatchObject({ state: "measuring", detail: ["target 50"], metric: "installs from the experiment's link" });
    expect(experimentLoop({ ...base, startedAt: daysAgo(20) }, now).state).toBe("late");
    expect(experimentLoop({ ...base, target: 50, status: "won", result: { value: 61, closedAt: now.toISOString() } }, now)).toMatchObject({ state: "closed", result: "won (61 vs target 50)" });
  });
});

describe("loops.md", () => {
  it("lists open loops first, warns about releases measured over the same days", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-loops-"));
    await writeRelease(root, release("2026-10-25T10-00-00Z-app-store", 11));
    await writeRelease(root, release("2026-10-30T10-00-00Z-app-store", 6, { note: "Fan in es-MX" }));
    await writeExperiment(root, { id: "2026-11-04-hooks", type: "ugc", hypothesis: "Before/after hooks get installs", metric: "link_installs", target: 50, startedAt: daysAgo(1), checkAfterDays: 14 });
    const loops = await collectLoops(root, now);
    expect(loops.map((l) => [l.id, l.state])).toEqual([
      ["2026-10-25T10-00-00Z-app-store", "late"],
      ["2026-10-30T10-00-00Z-app-store", "measuring"],
      ["2026-11-04-hooks", "measuring"],
    ]);
    await writeLoops(root, now);
    const md = readFileSync(join(root, "appeeky", "loops.md"), "utf8");
    expect(md).toContain("| late | 2026-11-01 | release · app-store | en-US subtitle: Lead with rain | target ranks | — |");
    expect(md).toContain("- `2026-10-25T10-00-00Z-app-store`: measured over the same days as 2026-10-30T10-00-00Z-app-store: the results mix");
    expect(md).toContain("Nothing closed yet.");
  });
});

describe("competitor changes in a window", () => {
  it("warns an open release about a competitor change during its days", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "spec-loops-"));
    await writeRelease(root, release("2026-10-30T10-00-00Z-app-store", 6));
    mkdirSync(join(root, "appeeky", "competitors"), { recursive: true });
    writeFileSync(
      join(root, "appeeky", "competitors", "changes.md"),
      "# Competitor changes\n\n- 2026-11-02 · Calm Night · App Store: title \"Calm Night\" → \"Calm Night: Rain Sounds\"\n- 2026-09-01 · Calm Night · App Store: version 5.1\n",
    );
    const [loop] = await collectLoops(root, now);
    expect(loop!.warnings).toEqual(['Calm Night changed on 2026-11-02, inside this window: App Store: title "Calm Night" → "Calm Night: Rain Sounds"']);
  });
});

describe("free stores", () => {
  it("is every store without an open release", async () => {
    const { freeStores } = await import("./loops.js");
    const open = releaseLoop(release("a", 3), now);
    const closed = releaseLoop(release("b", 20, { store: "google-play", checks: [check(7), check(14)] }), now);
    expect(freeStores([open, closed], ["app-store", "google-play"])).toEqual(["google-play"]);
  });
});
