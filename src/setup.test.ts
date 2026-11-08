import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, findApps, suggestTargets, targetCandidates } from "./setup.js";
import { makeProject } from "./test-helpers.js";

describe("finding the app", () => {
  it("reads Apple's search results", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ results: [{ trackId: 6479581124, trackName: "Phosum - Screenshot Pro", sellerName: "Webmob OU", bundleId: "com.phosum", averageUserRating: 4.66 }] }))) as unknown as typeof fetch;
    expect(await findApps("phosum", "us", fetcher)).toEqual([{ id: "6479581124", name: "Phosum - Screenshot Pro", developer: "Webmob OU", bundleId: "com.phosum", rating: 4.7 }]);
  });
});

describe("target candidates", () => {
  it("takes phrases from the name, subtitle and keyword field, without the brand or filler words", () => {
    const project = makeProject({ app: { name: "Sleep Sounds" } }, { "en-US": { name: "Sleep Sounds: Rain & Ocean", subtitle: "AI-powered white noise for baby", keywords: "brown noise,nap" } });
    expect(targetCandidates(project)).toEqual(["rain", "ocean", "white noise", "baby", "brown noise", "nap"]);
  });
  it("falls back to the App Store name before anything is pulled", () => {
    expect(targetCandidates(makeProject({ app: { name: "Phosum" } }), 14, "Phosum - Screenshot Pro")).toEqual(["screenshot pro"]);
  });
  it("puts searches the app already ranks for first, best first", async () => {
    const source = { label: "t", ranks: async () => ({ "white noise": 40, rain: 12 }) };
    expect(await suggestTargets(["rain", "ocean", "white noise", "brown noise"], "1", "us", source, 3)).toEqual([
      { keyword: "rain", rank: 12 },
      { keyword: "white noise", rank: 40 },
      { keyword: "brown noise", rank: null },
    ]);
  });
});

describe("doctor", () => {
  const env = { PATH: "" } as NodeJS.ProcessEnv;
  it("says what to run when there is no spec", () => {
    expect(diagnose("/x", null, env, "22.1.0").map((c) => [c.area, c.status])).toEqual([["node", "ok"], ["spec", "fail"]]);
  });
  it("finds the missing pieces of a spec", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-doctor-"));
    const project = { ...makeProject({ stores: { appStore: { appId: "1" } }, targets: { us: [] } }), root };
    const checks = diagnose(root, project, env, "18.0.0");
    const byArea = Object.fromEntries(checks.map((c) => [c.area, c.status]));
    expect(byArea).toMatchObject({ node: "fail", "App Store": "fail", "App Store listing": "warn", targets: "fail", "GitHub Actions": "warn", "specialist agents": "warn", ".gitignore": "warn" });
  });
  it("is happy with keys, targets, workflows and skills in place", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-doctor-"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "listing-check.yml"), "- uses: appeeky/appeeky-spec@v0\n");
    mkdirSync(join(root, ".claude", "skills", "appeeky-spec"), { recursive: true });
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(join(root, ".claude", "agents", "appeeky-aso.md"), "---\nname: appeeky-aso\n---\n");
    writeFileSync(join(root, ".gitignore"), ".appeeky/\n");
    const project = { ...makeProject({ stores: { appStore: { appId: "1" } }, targets: { us: ["rain"], de: ["regen"] } }, { "en-US": { name: "Sleep" } }), root };
    const checks = diagnose(root, project, { PATH: "", APPEEKY_API_KEY: "k" } as NodeJS.ProcessEnv, "22.1.0");
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.area === "App Store")?.detail).toContain("hosted");
    expect(checks.find((c) => c.area === "specialist agents")).toMatchObject({ status: "ok", detail: "installed for claude" });
  });
});

describe("saved store accounts", () => {
  it("reads the accounts the store CLIs saved, and doctor counts them as your own key", async () => {
    const { savedAccounts } = await import("./setup.js");
    const home = mkdtempSync(join(tmpdir(), "spec-home-"));
    mkdirSync(join(home, ".config", "gps"), { recursive: true });
    writeFileSync(join(home, ".config", "gps", "config.json"), JSON.stringify({ defaultAccount: "phosum", accounts: { phosum: { credentials: "sa.json" } } }));
    const env = { PATH: "", HOME: home } as NodeJS.ProcessEnv;
    expect(savedAccounts("google-play", env)).toEqual(["phosum"]);
    expect(savedAccounts("app-store", env)).toEqual([]);
    const project = makeProject({ stores: { googlePlay: { packageName: "com.x" } }, targets: { us: ["a"] } });
    const play = diagnose("/x", project, env, "22.1.0").find((c) => c.area === "Google Play");
    expect(play).toMatchObject({ status: "ok", detail: "your own key: npx @appeeky/google-play-store-cli, saved account phosum" });
  });
});

describe("the Google Play CLI's account flag", () => {
  it("is --account", async () => {
    const { STORE_CLIS } = await import("./transport.js");
    expect(STORE_CLIS["google-play"].accountFlag).toBe("--account");
  });
});
