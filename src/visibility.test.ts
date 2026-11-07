import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppeekyApi } from "./appeeky-api.js";
import { makeProject } from "./test-helpers.js";
import { applySync, planSync, pullVisibility, visibilityMetricSource, visibilityTarget } from "./visibility.js";

const opportunities = (status: "missing" | "winning", you: number) => ({
  summary: { winning: status === "winning" ? 1 : 0, weak: 0, missing: status === "missing" ? 1 : 0, noData: 0 },
  intents: [
    {
      intentId: "i1",
      label: "fall asleep to rain sounds",
      status,
      ownerVisibilityPct: you,
      byModel: { chatgpt: { visibilityPct: you, positionAvg: 2, promptsTotal: 3, date: "2026-11-01" } },
      winners: [{ name: "Calm", sharePct: 66.7, models: ["chatgpt"] }],
    },
  ],
  sources: { ownerDomain: "sleepsounds.app", sources: [{ domain: "reddit.com", url: "https://reddit.com/r/sleep", title: null, count: 4, models: ["perplexity"], citesOwner: false }] },
});

describe("AI visibility", () => {
  it("watches the App Store app in the first target storefront by default", () => {
    const project = makeProject({ targets: { us: ["sleep"], tr: ["uyku"] } });
    expect(visibilityTarget(project)).toEqual({ store: "app-store", appId: "123", countries: ["us"] });
    const play = makeProject({ aiVisibility: { store: "google-play", countries: ["gb", "de"] } });
    expect(visibilityTarget(play)).toEqual({ store: "google-play", appId: "com.example.sleep", countries: ["gb", "de"] });
  });

  it("writes what the assistants answer and records an intent it starts winning", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-visibility-"));
    const project = { ...makeProject({ targets: { us: ["sleep"] } }), root };
    let opp = opportunities("missing", 0);
    const api = {
      get: async (path: string) => (path.endsWith("/opportunities") ? opp : path.endsWith("/fixes") ? { fixes: [{ id: "f", intentId: "i1", kind: "content", title: "Get listed on the r/sleep wiki", rationale: "Perplexity cites it", targetUrl: null, status: "open" }] } : null),
    } as unknown as AppeekyApi;
    await pullVisibility(api, project, undefined, new Date("2026-11-01T00:00:00Z"));
    const yaml = readFileSync(join(root, "appeeky", "visibility", "us.yaml"), "utf8");
    expect(yaml).toContain("namedInstead:\n      - Calm (67%)");
    expect(yaml).toContain("title: Get listed on the r/sleep wiki");
    opp = opportunities("winning", 33);
    const [r] = await pullVisibility(api, project, undefined, new Date("2026-11-08T00:00:00Z"));
    expect(r!.changes).toEqual(['"fall asleep to rain sounds": missing → winning (0% → 33%), up']);
    expect(readFileSync(join(root, "appeeky", "visibility", "changes.md"), "utf8")).toContain("- 2026-11-08 · US · \"fall asleep to rain sounds\": missing → winning");
  });

  it("sends new intents and prompts, and archives the rest only with prune", async () => {
    const calls: string[] = [];
    const api = {
      get: async (path: string) =>
        path.endsWith("/intents")
          ? [
              { intentId: "i1", label: "Fall asleep to rain sounds", description: null, status: "active", visibilityPct: 0, promptsTotal: 2 },
              { intentId: "i2", label: "old intent nobody wants", description: null, status: "active", visibilityPct: 0, promptsTotal: 0 },
            ]
          : { prompts: [{ promptId: "p1", text: "best app for rain sounds at night", status: "active" }, { promptId: "p2", text: "an old prompt that we dropped", status: "active" }] },
      post: async (path: string, body: unknown) => {
        calls.push(`POST ${path} ${JSON.stringify(body)}`);
        return { id: "new" };
      },
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return {};
      },
    } as unknown as AppeekyApi;
    const plan = await planSync(api, "123", "us", [
      { label: "fall asleep to rain sounds", prompts: ["Best app for rain sounds at night", "what app plays rain to help me sleep"] },
      { label: "white noise for a crying baby", prompts: ["which white noise app helps a baby sleep"] },
    ]);
    expect(plan.addIntents.map((i) => i.label)).toEqual(["white noise for a crying baby"]);
    expect(plan.addPrompts.map((p) => p.text)).toEqual(["what app plays rain to help me sleep"]);
    expect(plan.extraIntents.map((i) => i.label)).toEqual(["old intent nobody wants"]);
    expect(plan.extraPrompts.map((p) => p.promptId)).toEqual(["p2"]);

    expect(await applySync(api, "123", plan, "en", false)).toEqual({ intents: 1, prompts: 2, archived: 0 });
    expect(calls).toEqual([
      'POST /ai-visibility/123/intents?country=us&language=en {"label":"white noise for a crying baby","description":null}',
      'POST /ai-visibility/123/intents/new/prompts?country=us&language=en {"text":"which white noise app helps a baby sleep"}',
      'POST /ai-visibility/123/intents/i1/prompts?country=us&language=en {"text":"what app plays rain to help me sleep"}',
    ]);
    calls.length = 0;
    await applySync(api, "123", { ...plan, addIntents: [], addPrompts: [] }, "en", true);
    expect(calls).toEqual(["DELETE /ai-visibility/123/prompts/p2", "DELETE /ai-visibility/123/intents/i2"]);
  });

  it("gives verify ai_visibility averaged over the assistants and scanned days", async () => {
    const asked: string[] = [];
    const api = {
      get: async (_path: string, q: Record<string, string>) => {
        asked.push(q.model!);
        if (q.model === "chatgpt") return [{ date: "2026-10-02", visibilityPct: 10 }, { date: "2026-10-10", visibilityPct: 30 }];
        if (q.model === "perplexity") return [{ date: "2026-10-02", visibilityPct: 30 }];
        return [];
      },
    } as unknown as AppeekyApi;
    const source = visibilityMetricSource(api, makeProject({ targets: { us: ["sleep"] } }))!;
    const before = await source.window("app-store", "123", "2026-10-01", "2026-10-08");
    const after = await source.window("app-store", "123", "2026-10-08", "2026-10-15");
    expect(before?.values.ai_visibility).toBeCloseTo(0.2);
    expect(after?.values.ai_visibility).toBeCloseTo(0.3);
    expect(await source.window("google-play", "x", "2026-10-01", "2026-10-08")).toBeNull();
    expect(asked.sort()).toEqual(["chatgpt", "claude", "gemini", "perplexity"]); // once per assistant per run
  });
});
