import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { makeProject } from "./test-helpers.js";
import { loadVisibilityCore, localVisibilityMetricSource, ownDomains, ownerNames, planLocalScan, scanLocal, type VisibilityCore } from "./visibility-local.js";

// The real bundled pipeline (vendor/visibility-core.js), with the providers faked.
const core = () => loadVisibilityCore(() => import("../vendor/visibility-core.js" as string));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** OpenAI answers with web search and does the extraction; Perplexity answers with citations. */
function providers(answers: { chatgpt: string; perplexity: string }) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (u.endsWith("/v1/responses")) {
      return json({
        output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: answers.chatgpt, annotations: [{ type: "url_citation", url: "https://sleepsounds.app/rain", title: "Rain", start_index: answers.chatgpt.length, end_index: answers.chatgpt.length }] }] }],
        usage: { input_tokens: 1000, output_tokens: 300 },
      });
    }
    if (u.includes("perplexity")) return json({ choices: [{ message: { content: answers.perplexity } }], search_results: [{ url: "https://www.reddit.com/r/sleep", title: "r/sleep" }], usage: { prompt_tokens: 200, completion_tokens: 200 } });
    if (u.endsWith("/chat/completions")) {
      // The extraction pass: list the apps the answer names, in order.
      const answer = /Assistant's answer:\n {2}"""([\s\S]*?)"""/.exec(body.messages[0].content)![1]!;
      const apps = [...answer.matchAll(/\d\. ([^—\n]+?) —/g)].map((m, i) => ({ appName: m[1]!.trim(), position: i + 1, citationIndex: null }));
      return json({ choices: [{ message: { content: JSON.stringify({ refusal: false, apps }) } }], usage: { prompt_tokens: 500, completion_tokens: 50 } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

const intents = { us: [{ label: "Fall asleep to rain", prompts: ["what app plays rain sounds to fall asleep", "best free white noise app for sleeping"] }] };

describe("AI visibility on your own keys", () => {
  it("quotes only the assistants that have a key", async () => {
    const c: VisibilityCore = await core();
    const project = makeProject({ targets: { us: ["rain sounds"] }, aiVisibility: { intents } });
    const plan = planLocalScan(c, project, "us", { OPENAI_API_KEY: "sk", PERPLEXITY_API_KEY: "pk" });
    expect(plan.models).toEqual(["chatgpt", "perplexity"]);
    expect(plan.prompts).toBe(2);
    expect(plan.helper?.modelId).toBe("gpt-4.1-mini");
    expect(plan.quoteUsd).toBeGreaterThan(0);
    expect(planLocalScan(c, project, "us", {}).models).toEqual([]);
  });

  it("asks, extracts, scores, and writes the same file as visibility pull", async () => {
    const c = await core();
    const root = mkdtempSync(join(tmpdir(), "spec-vis-local-"));
    const project = {
      ...makeProject({ targets: { us: ["rain sounds"] }, aiVisibility: { intents, aliases: ["Rain Sleep"] }, web: { url: "https://sleepsounds.app" } }, { "en-US": { name: "Sleep Sounds: Rain & Noise" } }),
      root,
    };
    const env = { OPENAI_API_KEY: "sk", PERPLEXITY_API_KEY: "pk" };
    const { fetcher } = providers({
      chatgpt: "1. Calm — guided sleep.\n2. Sleep Sounds — rain and fan sounds.",
      perplexity: "1. Calm — popular.\n2. BetterSleep — mixes sounds.",
    });
    const r = await scanLocal(c, project, planLocalScan(c, project, "us", env), env, { fetcher, now: new Date("2026-11-08T00:00:00Z") });
    expect(r.answered).toBe(4);
    expect(r.failed).toEqual([]);
    const file = YAML.parse(readFileSync(join(root, "appeeky/visibility/us.yaml"), "utf8"));
    expect(file.source).toBe("local");
    expect(file.intents[0]).toMatchObject({ label: "Fall asleep to rain", status: "winning", you: 50, byModel: { chatgpt: 100, perplexity: 0 } });
    expect(file.intents[0].namedInstead[0]).toBe("Calm (100%)");
    expect(file.sources).toContainEqual({ domain: "sleepsounds.app", count: 2, yours: true, url: "https://sleepsounds.app/rain" });
    expect(readFileSync(join(root, "appeeky/visibility/history.csv"), "utf8")).toContain("2026-11-08,us,Fall asleep to rain,chatgpt,100,2,2");
    expect(readFileSync(join(root, "appeeky/visibility/answers/us.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);

    const source = localVisibilityMetricSource(project)!;
    expect((await source.window("app-store", "123", "2026-11-01", "2026-11-09"))?.values.ai_visibility).toBe(0.5);
  });

  it("keeps a provider's error per answer instead of failing the scan", async () => {
    const c = await core();
    const root = mkdtempSync(join(tmpdir(), "spec-vis-local-"));
    const project = { ...makeProject({ aiVisibility: { intents } }), root };
    const env = { OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "bad" };
    const { fetcher: ok } = providers({ chatgpt: "1. Calm — guided sleep.", perplexity: "" });
    const fetcher = (async (url: string | URL, init?: RequestInit) =>
      String(url).includes("anthropic") ? new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 }) : ok(url, init)) as typeof fetch;
    const r = await scanLocal(c, project, planLocalScan(c, project, "us", env), env, { fetcher });
    expect(r.failed).toEqual([
      { model: "claude", error: "401 invalid x-api-key" },
      { model: "claude", error: "401 invalid x-api-key" },
    ]);
    expect(r.data.intents[0]).toMatchObject({ status: "missing", byModel: { chatgpt: 0 } });
  });

  it("recognises the app by its names and its own domains", async () => {
    const c = await core();
    const project = makeProject({ aiVisibility: { intents: {}, aliases: ["Rainy"] }, web: { url: "https://www.sleepsounds.app/" } }, { "en-US": { name: "Sleep Sounds: Rain & Noise", supportUrl: "https://apps.apple.com/x" } });
    const names = ownerNames(project);
    expect(c.isOwner("Sleep Sounds", names)).toBe(true);
    expect(c.isOwner("Sleep Sounds: Rain & Noise app", names)).toBe(true);
    expect(c.isOwner("Rainy", names)).toBe(true);
    expect(c.isOwner("Calm", names)).toBe(false);
    expect(c.isOwner("Sleep", names)).toBe(false);
    expect(ownDomains(project)).toEqual(["sleepsounds.app"]);
  });
});
