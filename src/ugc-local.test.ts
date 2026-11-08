import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { readBriefs } from "./ugc.js";
import { generateLocal, loadCore, planLocalClip, readLocalPersona } from "./ugc-local.js";

/** A stand-in for @appeeky/ugc-core: fixed prices, and a fal client that records what it was asked. */
function fakeCore() {
  const submitted: Array<{ endpoint: string; input: Record<string, unknown> }> = [];
  const uploads: string[] = [];
  const job = (endpoint: string, costUsd: number, request: Record<string, unknown>) => ({ costUsd, request, model: { endpoint, mapInput: (r: unknown) => r as Record<string, unknown> } });
  const core = {
    MAX_SCRIPT_CHARS: 200,
    PLACEHOLDER_IMAGE: "https://placeholder",
    getMediaModel: (id: string) => ({ id, kind: "video", mode: "image", label: id, nativeAudio: true }),
    fitDuration: (_m: unknown, s: number) => Math.min(8, s),
    prepareImageJob: (i: Record<string, unknown>) => job("fal/still", 0.04, i),
    prepareVideoJob: (i: Record<string, unknown>) => job("fal/video", 1.2, i),
    buildCreatorLock: (p: unknown) => p,
    negativesFor: () => ["no text"],
    stillPrompt: (i: Record<string, unknown>) => `still: ${String(i.direction)}`,
    talkingVideoPrompt: (i: Record<string, unknown>) => `says: ${String(i.script)}`,
    extractOutputUrls: (r: unknown) => [{ url: (r as { url: string }).url }],
    createFalClient: () => ({
      async submit(endpoint: string, input: Record<string, unknown>) {
        submitted.push({ endpoint, input });
        return { statusUrl: `${endpoint}/status`, responseUrl: endpoint };
      },
      async status() {
        return { state: "completed" };
      },
      async result(url: string) {
        return { url: url === "fal/still" ? "https://fal/still.png" : "https://fal/clip.mp4" };
      },
      async upload(f: { fileName: string }) {
        uploads.push(f.fileName);
        return `https://fal/${f.fileName}`;
      },
    }),
  };
  return { core, submitted, uploads };
}

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "spec-ugc-local-"));
  mkdirSync(join(root, "appeeky/ugc/personas/maya"), { recursive: true });
  mkdirSync(join(root, "appeeky/ugc/briefs"), { recursive: true });
  writeFileSync(join(root, "appeeky/ugc/personas/maya/front.png"), "png");
  writeFileSync(join(root, "appeeky/ugc/personas/maya.yaml"), YAML.stringify({ name: "Maya", appearance: "late 20s, curly hair", looks: ["maya/front.png", "https://cdn/side.jpg"] }));
  writeFileSync(join(root, "appeeky/ugc/briefs/hook.yaml"), YAML.stringify({ persona: "Maya", script: "Out in ten minutes.", scene: "a dark nursery", durationSec: 12 }));
  return root;
};

describe("ugc generate --local", () => {
  it("reads a persona kept in the repo with its looks next to it", async () => {
    const root = repo();
    const p = await readLocalPersona(root, "Maya");
    expect(p).toMatchObject({ id: "maya", name: "Maya", looks: [join(root, "appeeky/ugc/personas/maya/front.png"), "https://cdn/side.jpg"] });
    expect(await readLocalPersona(root, "nobody")).toBeUndefined();
  });

  it("quotes still + video in USD, with the duration fitted to the model", async () => {
    const root = repo();
    const { core } = fakeCore();
    const [brief] = await readBriefs(root);
    const maya = (await readLocalPersona(root, "Maya"))!;
    const plan = planLocalClip(core, maya, brief!, []);
    expect(plan.costUsd).toBe(1.24);
    expect(plan.clip).toEqual({ durationSec: 8, aspectRatio: "9:16", videoModelId: "veo-3.1-fast" });
    expect(() => planLocalClip(core, maya, { ...brief!, script: "a".repeat(201) }, [])).toThrow(/too long/);
  });

  it("uploads local looks, runs still then video on fal, saves the clip and records it in the brief", async () => {
    const root = repo();
    const { core, submitted, uploads } = fakeCore();
    const [brief] = await readBriefs(root);
    const fetcher = (async () => new Response("mp4-bytes")) as unknown as typeof fetch;
    const r = await generateLocal(core, root, brief!, (await readLocalPersona(root, "Maya"))!, "key", { fetcher, sleep: async () => {}, now: new Date("2026-11-08T00:00:00Z") });
    expect(uploads).toEqual(["front.png"]);
    expect(submitted.map((s) => s.endpoint)).toEqual(["fal/still", "fal/video"]);
    expect(submitted[0]!.input).toMatchObject({ imageUrls: ["https://fal/front.png", "https://cdn/side.jpg"], prompt: "still: a dark nursery" });
    expect(submitted[1]!.input).toMatchObject({ imageUrl: "https://fal/still.png", prompt: "says: Out in ten minutes.", audio: true, durationSec: 8 });
    expect(readFileSync(r.file, "utf8")).toBe("mp4-bytes");
    const [saved] = await readBriefs(root);
    expect(saved).toMatchObject({ status: "generated", clipFile: ".appeeky/media/hook.mp4", videoUrl: "https://fal/clip.mp4", costUsd: 1.24, generatedAt: "2026-11-08T00:00:00.000Z" });
  });

  it("loads the bundled pipeline, and says to update Spec when it is missing", async () => {
    const asked: string[] = [];
    await loadCore(async (s) => (asked.push(s), {}));
    expect(asked).toEqual(["./ugc-core.js"]);
    await expect(loadCore(async () => { throw new Error("not found"); })).rejects.toThrow(/npm install -g @appeeky\/spec@latest/);
  });
});
