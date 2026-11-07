import { describe, expect, it } from "vitest";
import { appStoreCoverage, googlePlayCoverage, projectCoverage } from "./coverage.js";
import { indexedLocales } from "./storefronts.js";
import { makeProject } from "./test-helpers.js";

const levels = (r: { keywords: { keyword: string; level: string }[] }) => Object.fromEntries(r.keywords.map((k) => [k.keyword, k.level]));

describe("appStoreCoverage", () => {
  const project = makeProject(
    { targets: { us: ["sleep sounds", "white noise", "rain sounds", "baby sleep", "ruido blanco", "meditation timer", "Brown Noise"] } },
    {
      "en-US": { name: "Sleep Sounds", subtitle: "White noise machine", keywords: "rain,baby,brown" },
      "es-MX": { name: "Sonidos", keywords: "ruido,blanco,timer" },
    },
  );

  it("grades each target by where its words are indexed", () => {
    const report = appStoreCoverage(project, "us");
    expect(report.locales).toEqual(["en-US", "es-MX"]);
    expect(levels(report)).toEqual({
      "sleep sounds": "title",
      "white noise": "subtitle",
      "rain sounds": "full",
      "baby sleep": "full",
      "ruido blanco": "full",
      "meditation timer": "partial",
      "brown noise": "full",
    });
    expect(report.covered).toBe(6);
    expect(report.percent).toBe(86);
  });

  it("marks words that only meet across locales as split", () => {
    const p = makeProject({ targets: { us: ["sleep timer"] } }, { "en-US": { name: "Sleep" }, "es-MX": { keywords: "timer" } });
    expect(levels(appStoreCoverage(p, "us"))).toEqual({ "sleep timer": "split" });
  });

  it("weights by popularity when every target has it", () => {
    const p = makeProject({ targets: { us: ["sleep", "storm"] } }, { "en-US": { name: "Sleep" } });
    const report = appStoreCoverage(p, "us", (k) => ({ popularity: k === "sleep" ? 60 : 20, difficulty: 40 }));
    expect(report.percent).toBe(50);
    expect(report.weightedPercent).toBe(75);
  });

  it("honours storefront overrides and falls back to the primary locale", () => {
    const p = makeProject({ storefronts: { de: ["en-US"] } }, { "en-US": {}, "de-DE": {} });
    expect(indexedLocales(p, "de")).toEqual(["en-US"]);
    expect(indexedLocales(p, "zz")).toEqual(["en-US"]);
  });
});

describe("stopwords", () => {
  it("does not require filler words of a phrase", () => {
    const p = makeProject({ targets: { us: ["screenshot to text", "the"] } }, { "en-US": { name: "Screenshot", keywords: "text,the" } });
    expect(levels(appStoreCoverage(p, "us"))).toEqual({ "screenshot to text": "full", the: "full" });
  });
});

describe("play language codes", () => {
  it("maps App Store locales to Google Play languages", async () => {
    const { playLanguageCode } = await import("./storefronts.js");
    expect(["tr", "zh-Hans", "es-MX", "de-DE", "he"].map(playLanguageCode)).toEqual(["tr-TR", "zh-CN", "es-419", "de-DE", "iw-IL"]);
  });
});

describe("googlePlayCoverage", () => {
  it("uses title, short description and full description", () => {
    const p = makeProject(
      { targets: { us: ["sleep sounds", "white noise", "rain", "tinnitus relief", "fan"] } },
      {},
      { "en-US": { title: "Sleep Sounds", shortDescription: "White noise & rain", fullDescription: "Helps with tinnitus." } },
    );
    expect(levels(googlePlayCoverage(p, "us"))).toEqual({
      "sleep sounds": "title",
      "white noise": "short",
      rain: "short",
      "tinnitus relief": "partial",
      fan: "none",
    });
  });
});

describe("projectCoverage", () => {
  it("reports each store that has listings", () => {
    const p = makeProject({ targets: { us: ["sleep"], tr: ["uyku"] } }, { "en-US": { name: "Sleep" } });
    expect(projectCoverage(p).map((r) => `${r.store}:${r.country}`)).toEqual(["app-store:us", "app-store:tr"]);
  });
});
