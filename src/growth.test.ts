import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { closeExperiment, dueExperiments, experimentSchema } from "./experiments.js";
import { loadProject, writeListing, writeSpec } from "./files.js";
import { writeRelease, type ReleaseRecord } from "./history.js";
import { appendPlaybook, dueMilestone, playbookLine, verifyReleases } from "./measure.js";
import { loadProjectAtRef, specReport } from "./report.js";
import { checkScreenshots, imageSize } from "./screenshots.js";
import { appendKeyword, competitorGaps, crossLocalizationSuggestions, keywordSuggestions } from "./suggest.js";
import { makeProject } from "./test-helpers.js";
import { evaluateRanks, firstRankSource, itunesRankSource, type RankSource } from "./verify.js";

describe("suggestions", () => {
  it("appends keywords compactly and refuses what does not fit", () => {
    expect(appendKeyword("rain, storm", "fan")).toBe("rain,storm,fan");
    expect(appendKeyword("rain", "RAIN")).toBe("rain");
    expect(appendKeyword("x".repeat(98), "fan")).toBeNull();
  });

  it("suggests missing target words and API candidates for a locale", () => {
    const p = makeProject({ targets: { us: ["white noise", "sleep sounds"] } }, { "en-US": { name: "Sleep Sounds", keywords: "rain" } });
    const s = keywordSuggestions(p, "en-US", [{ keyword: "baby lullaby", popularity: 40 }]);
    expect(s.map((x) => x.word)).toEqual(["white", "noise", "baby", "lullaby"]);
    expect(s[0]).toMatchObject({ helps: ["white noise"], fits: true, target: true });
    expect(s[2]).toMatchObject({ popularity: 40, target: false });
  });

  it("ignores candidate phrases unrelated to the listing and targets", () => {
    const p = makeProject({ targets: { us: ["screenshot organizer"] } }, { "en-US": { name: "Phosum", subtitle: "Screenshot Search" } });
    const s = keywordSuggestions(p, "en-US", [
      { keyword: "proton vpn", popularity: 74, source: "suggestion" },
      { keyword: "the possum", popularity: 29, source: "suggestion" },
      { keyword: "screenshot stitching", popularity: 54, source: "suggestion" },
    ]);
    expect(s.map((x) => x.word)).toEqual(["organizer", "stitching"]);
  });

  it("fills the secondary locale of a storefront with missing words", () => {
    const p = makeProject(
      { targets: { us: ["white noise", "rain sounds", "sleep"] } },
      { "en-US": { name: "Sleep", keywords: "x".repeat(96) }, "es-MX": { keywords: "lluvia" } },
    );
    expect(crossLocalizationSuggestions(p)).toEqual([
      { country: "us", locale: "es-MX", add: ["white", "noise", "rain", "sounds"], keywords: "lluvia,white,noise,rain,sounds" },
    ]);
  });

  it("splits a keyword field written as one phrase before adding words", () => {
    const p = makeProject(
      { targets: { us: ["screenshot organizer", "ai screenshot"] } },
      { "en-US": { name: "Phosum", subtitle: "Screenshot Organizer" }, "es-MX": { keywords: "captura pantalla organizar buscar screenshot" } },
    );
    expect(crossLocalizationSuggestions(p)).toEqual([
      { country: "us", locale: "es-MX", add: ["ai"], keywords: "captura,pantalla,organizar,buscar,screenshot,ai", splitPhrase: true },
    ]);
  });

  it("turns competitor changes into openings", () => {
    const p = makeProject({ targets: { us: ["white noise", "rain sounds"] } }, { "en-US": { name: "Rain Sounds" } });
    const gaps = competitorGaps(p, "us", [
      { competitor: "Calm", field: "subtitle", before: "White noise & rain", after: "Sleep stories", at: "2026-10-30" },
      { competitor: "Calm", field: "subtitle", before: "Meditate", after: "Meditate daily", at: "2026-10-01" },
      { competitor: "Calm", field: "subtitle", before: "White noise", after: null, at: "2026-09-01" },
    ]);
    expect(gaps).toEqual([{ competitor: "Calm", field: "subtitle", at: "2026-10-30", dropped: ["white", "noise", "rain"], added: [], openings: ["white", "noise"] }]);
  });
});

describe("rank evaluation", () => {
  it("calls a release lost by the co-founder's revert rule", () => {
    const before = { us: { a: 4, b: 15, c: 30, d: null, e: 18 } };
    expect(evaluateRanks(before, { us: { a: null, b: 16, c: 22, d: 40, e: 19 } }).verdict).toBe("lost");
    expect(evaluateRanks(before, { us: { a: 4, b: 30, c: 22, d: 40, e: 19 } }).verdict).toBe("won");
    const two = evaluateRanks({ us: { b: 15, e: 18 } }, { us: { b: 40, e: null } });
    expect(two.regressions.map((r) => r.keyword)).toEqual(["b", "e"]);
    expect(two.verdict).toBe("lost");
    expect(evaluateRanks({ us: { a: 5 } }, { us: { a: 6 } }).verdict).toBe("flat");
    // Not ranked before and after is no move (it used to count as a rise).
    expect(evaluateRanks({ us: { a: null } }, { us: { a: null } })).toMatchObject({ improved: [], dropped: [], verdict: "flat" });
    expect(evaluateRanks({ us: { a: null } }, { us: { a: 150 } }).improved).toHaveLength(1);
  });

  it("reads App Store ranks from Apple's search and falls back across sources", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ results: [{ trackId: 1 }, { trackId: 42 }] }))) as unknown as typeof fetch;
    expect(await itunesRankSource(fetcher).ranks("app-store", "42", "us", ["rain"])).toEqual({ rain: 2 });
    const broken: RankSource = { label: "broken", ranks: async () => Promise.reject(new Error("down")) };
    const partial: RankSource = { label: "partial", ranks: async () => ({ rain: 3 }) };
    expect(await firstRankSource(broken, partial, itunesRankSource(fetcher)).ranks("app-store", "42", "us", ["rain", "fan"])).toEqual({ rain: 3, fan: 2 });
  });
});

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "spec-growth-"));
  return root;
}

describe("verify", () => {
  it("measures due releases once per milestone and writes a playbook line", async () => {
    const root = tempProject();
    await writeSpec(root, { version: 1, app: { name: "Sleep" }, stores: { appStore: { appId: "42" } }, targets: { us: ["rain", "fan"] } });
    const pushedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const release: ReleaseRecord = {
      id: "2026-10-23T10-00-00Z-app-store",
      pushedAt,
      store: "app-store",
      target: "version 2.4",
      via: "test",
      note: "Lead with rain",
      changes: [{ locale: "en-US", field: "subtitle", before: "Calm", after: "Rain & fan" }],
      baseline: { at: pushedAt, source: "test", ranks: { us: { rain: 30, fan: null } } },
    };
    await writeRelease(root, release);
    expect(dueMilestone(release)).toBe(7);

    const source: RankSource = { label: "test", ranks: async () => ({ rain: 12, fan: 25 }) };
    const project = await loadProject(root);
    const [result] = await verifyReleases(project, source);
    expect(result!.check).toMatchObject({ day: 7, verdict: "won" });
    expect(await verifyReleases(project, source)).toEqual([]);

    expect(await appendPlaybook(root, [playbookLine(result!)])).toBe(1);
    expect(await appendPlaybook(root, [playbookLine(result!)])).toBe(0);
    expect(readFileSync(join(root, "appeeky/playbook.md"), "utf8")).toContain('Lead with rain → day 7 won ("rain" 30→12; "fan" –→25)');
    const saved = YAML.parse(readFileSync(join(root, "appeeky/releases", `${release.id}.yaml`), "utf8"));
    expect(saved.checks).toHaveLength(1);
  });
});

describe("conversion", () => {
  it("compares the window before a push with the window after it", async () => {
    const calls: string[] = [];
    const source = {
      label: "test",
      conversion: async (_s: string, _a: string, from: string, to: string) => {
        calls.push(`${from}..${to}`);
        return from < "2026-05-20" ? { rate: 0.2, visitors: 100, installs: 20, days: 7 } : { rate: 0.25, visitors: 120, installs: 30, days: 7 };
      },
    };
    const { measureConversion } = await import("./verify.js");
    const r = await measureConversion(source as never, "app-store", "1", "2026-05-20T10:00:00Z", 7);
    expect(calls).toEqual(["2026-05-13..2026-05-20", "2026-05-21..2026-05-28"]);
    expect(r?.change).toBeCloseTo(0.25);
  });
});

describe("experiments", () => {
  it("is due after its check date and closes against its target", () => {
    const e = experimentSchema.parse({
      id: "2026-10-01-hook",
      type: "ugc",
      hypothesis: "Before/after hooks get more installs",
      metric: "install_per_1k_views",
      baseline: 1.8,
      target: 2.5,
      startedAt: "2026-10-01T00:00:00Z",
    });
    expect(dueExperiments([e], new Date("2026-10-10"))).toEqual([]);
    expect(dueExperiments([e], new Date("2026-10-16"))).toHaveLength(1);
    expect(closeExperiment(e, 2.7, undefined).status).toBe("won");
    expect(closeExperiment(e, 2.1, undefined).status).toBe("lost");
    expect(closeExperiment({ ...e, target: undefined }, 2.1, undefined).status).toBe("inconclusive");
  });
});

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("screenshots", () => {
  it("reads sizes and flags wrong ones", async () => {
    const root = tempProject();
    const dir = join(root, "appeeky/screenshots/app-store/en-US/APP_IPHONE_67");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01.png"), png(1290, 2796));
    writeFileSync(join(dir, "02.png"), png(2796, 1290));
    writeFileSync(join(dir, "03.png"), png(1242, 2688));
    expect(await imageSize(join(dir, "01.png"))).toEqual({ width: 1290, height: 2796 });
    const issues = await checkScreenshots(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/03.png is 1242×2688/);
  });
});

describe("report", () => {
  it("compares the spec with a git ref", async () => {
    const root = tempProject();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeSpec(root, { version: 1, app: { name: "Sleep" }, stores: { appStore: { appId: "1" } }, targets: { us: ["white noise", "rain"] } });
    await writeListing(root, "app-store", "en-US", { name: "Sleep", keywords: "rain" });
    git("add", "-A");
    git("commit", "-qm", "base");
    await writeListing(root, "app-store", "en-US", { name: "Sleep", subtitle: "White noise", keywords: "fan" });

    const base = await loadProjectAtRef(root, "main");
    expect(base?.listings["app-store"]["en-US"]).toEqual({ name: "Sleep", keywords: "rain" });
    const md = specReport(base, await loadProject(root));
    expect(md).toContain("**2 listing fields changed**");
    expect(md).toContain("| App Store US | 50% → 50% | white noise | **rain** |");
    expect(await loadProjectAtRef(root, "does-not-exist")).toBeNull();
    const shot = { severity: "error" as const, rule: "screenshots", store: "app-store" as const, locale: "en-US", field: "APP_IPHONE_67", message: "01.png is 100×100." };
    expect(specReport(base, await loadProject(root), [shot])).toContain("- ❌ app-store en-US APP_IPHONE_67: 01.png is 100×100.");
  });
});

void makeProject;
