import { describe, expect, it } from "vitest";
import { hasErrors, lintAppStore, lintGooglePlay, lintProject } from "./lint.js";
import { makeProject } from "./test-helpers.js";

const rules = (issues: { rule: string }[]) => issues.map((i) => i.rule);

describe("lintAppStore", () => {
  it("flags fields over the store limits", () => {
    const issues = lintAppStore("en-US", { name: "x".repeat(31), keywords: "ü".repeat(101) });
    expect(issues.filter((i) => i.rule === "limit").map((i) => i.field)).toEqual(["name", "keywords"]);
    expect(hasErrors(issues)).toBe(true);
  });

  it("counts the keyword field in characters, like App Store Connect", () => {
    // 100 Cyrillic letters are 200 bytes but within the limit (live Russian fields are 169 bytes).
    expect(rules(lintAppStore("ru", { keywords: "ж".repeat(100) }))).not.toContain("limit");
    expect(rules(lintAppStore("ru", { keywords: "ж".repeat(101) }))).toContain("limit");
  });

  it("catches wasted space and words already in the name or subtitle", () => {
    const issues = lintAppStore("en-US", {
      name: "Sleep Sounds: Rain",
      subtitle: "White noise for sleep",
      keywords: "rain, calm,noise,calm,the,storm",
    });
    expect(rules(issues)).toEqual(
      expect.arrayContaining(["subtitle/repeats-name", "keywords/spaces", "keywords/duplicate", "keywords/duplicate-of-name", "keywords/filler", "keywords/unused-space"]),
    );
    expect(hasErrors(issues)).toBe(false);
  });

  it("flags a keyword field written without commas", () => {
    expect(rules(lintAppStore("es-MX", { keywords: "captura pantalla organizar buscar" }))).toContain("keywords/no-commas");
    expect(rules(lintAppStore("es-MX", { keywords: "captura pantalla,organizar" }))).not.toContain("keywords/no-commas");
  });

  it("notes plural pairs only for English", () => {
    expect(rules(lintAppStore("en-US", { name: "Sound", keywords: "sounds" }))).toContain("keywords/plural-pair");
    expect(rules(lintAppStore("de-DE", { name: "Sound", keywords: "sounds" }))).not.toContain("keywords/plural-pair");
  });

  it("is quiet for a tight listing", () => {
    const issues = lintAppStore("en-US", {
      name: "Sleep Sounds: Rain & Ocean",
      subtitle: "White noise, fan, lullaby",
      keywords: "insomnia,relax,meditation,storm,thunder,baby,nap,calm,ambient,brown,pink,asmr,forest,deep,tinnitus",
    });
    expect(issues).toEqual([]);
  });
});

describe("lintGooglePlay", () => {
  it("applies Play title policy", () => {
    expect(rules(lintGooglePlay("en-US", { title: "Best Sleep App #1 🌙" }))).toEqual(expect.arrayContaining(["play/title-policy", "play/title-emoji"]));
    expect(rules(lintGooglePlay("en-US", { title: "SLEEP SOUNDS" }))).toContain("play/title-caps");
    expect(rules(lintGooglePlay("en-US", { shortDescription: "x".repeat(81) }))).toContain("limit");
  });
});

describe("lintProject", () => {
  it("suggests pulling when a configured store has no listings", () => {
    expect(rules(lintProject(makeProject()))).toEqual(["listings/empty", "listings/empty"]);
  });
});
