import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import YAML from "yaml";
import type { AppeekyApi } from "./appeeky-api.js";
import { SPEC_DIR } from "./files.js";
import type { Brief } from "./ugc.js";

/**
 * Clips made on this machine with the user's own fal key (FAL_KEY), the same pipeline as Appeeky's
 * hosted UGC and the desktop app's local mode: the persona's look → a still in the scene → a talking
 * video with the script in the persona's voice. Planning, prompts and prices come from Appeeky's
 * UGC core, bundled into dist/ugc-core.js and loaded only when this runs; fal bills the user directly.
 *
 * Personas come from either:
 *   appeeky/ugc/personas/<name>.yaml   a persona kept in the repo, `looks:` pointing at its images
 *   Appeeky UGC                         a persona made in Appeeky (APPEEKY_API_KEY), its cover as the look
 */

export const localPersonasDir = (root: string) => join(root, SPEC_DIR, "ugc", "personas");
export const mediaDir = (root: string) => join(root, ".appeeky", "media");

/** The UgcPersona fields the prompts read; everything else stays at its default. */
export interface LocalPersona {
  id: string;
  name: string;
  appearance?: string;
  personality?: string;
  bio?: string;
  voice?: string;
  lane?: string;
  identity?: Record<string, unknown>;
  signatureDetails?: string[];
  imperfections?: string[];
  cameraHabits?: Record<string, unknown>;
  voiceProfile?: Record<string, unknown>;
  neverChange?: string[];
  style?: Record<string, unknown>;
  /** Image files (relative to the persona file) or URLs that show the persona. */
  looks: string[];
}

interface PreparedJob {
  costUsd: number;
  model: { endpoint: string; mapInput(request: unknown): Record<string, unknown> };
  request: unknown;
}

interface Core {
  MAX_SCRIPT_CHARS: number;
  getMediaModel(id: string): { id: string; kind: string; mode: string; label: string; nativeAudio?: boolean } | undefined;
  fitDuration(model: unknown, seconds: number): number;
  prepareImageJob(input: Record<string, unknown>): PreparedJob;
  prepareVideoJob(input: Record<string, unknown>): PreparedJob;
  createFalClient(key: string): {
    submit(endpoint: string, input: Record<string, unknown>): Promise<{ statusUrl: string; responseUrl: string }>;
    status(url: string): Promise<{ state: string; error?: string }>;
    result(url: string): Promise<unknown>;
    upload(file: { data: Uint8Array; contentType: string; fileName: string }): Promise<string>;
  };
  extractOutputUrls(result: unknown): Array<{ url: string; contentType?: string }>;
  buildCreatorLock(persona: unknown): unknown;
  negativesFor(lock: unknown, opts: { video: boolean }): string[];
  stillPrompt(input: Record<string, unknown>): string;
  talkingVideoPrompt(input: Record<string, unknown>): string;
  PLACEHOLDER_IMAGE: string;
}

/** The UGC pipeline ships inside Spec as one minified file (dist/ugc-core.js, built by scripts/vendor-ugc-core.mjs). */
export const CORE_FILE = "./ugc-core.js";

export async function loadCore(load: (specifier: string) => Promise<Record<string, unknown>> = (s) => import(s)): Promise<Core> {
  try {
    return (await load(CORE_FILE)) as unknown as Core;
  } catch {
    throw new Error("This build of @appeeky/spec has no UGC pipeline (dist/ugc-core.js). Update it: npm install -g @appeeky/spec@latest");
  }
}

function asUgcPersona(p: LocalPersona): Record<string, unknown> {
  return {
    ownerEmail: "",
    appId: null,
    status: "active",
    bio: "",
    story: "",
    personality: "",
    appearance: "",
    voice: "",
    voiceId: null,
    style: {},
    identity: {},
    signatureDetails: [],
    imperfections: [],
    cameraHabits: {},
    voiceProfile: {},
    neverChange: [],
    lane: "",
    formats: [],
    contentPillars: [],
    platforms: [],
    referenceAssetIds: p.looks,
    folderId: null,
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}

/** A persona kept in the repo (appeeky/ugc/personas/<name>.yaml), with its looks resolved to paths or URLs. */
export async function readLocalPersona(root: string, name: string): Promise<LocalPersona | undefined> {
  const dir = localPersonasDir(root);
  if (!existsSync(dir)) return undefined;
  const slug = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const hit = (await readdir(dir)).find((f) => f.endsWith(".yaml") && slug(basename(f, ".yaml")) === slug(name));
  if (!hit) return undefined;
  const file = join(dir, hit);
  const raw = YAML.parse(await readFile(file, "utf8")) as Partial<LocalPersona> | null;
  if (!raw?.looks?.length) throw new Error(`${relative(root, file)} needs looks: the persona's images (paths next to the file, or URLs).`);
  return {
    ...raw,
    id: raw.id ?? basename(file, ".yaml"),
    name: raw.name ?? basename(file, ".yaml"),
    looks: raw.looks.map((l) => (/^https?:\/\//.test(l) || isAbsolute(l) ? l : join(dirname(file), l))),
  } as LocalPersona;
}

/** A persona made in Appeeky UGC: its fields, with the cover image as its look. */
export async function readAppeekyPersona(api: AppeekyApi, name: string): Promise<LocalPersona | undefined> {
  const res = await api.get<{ personas: Array<Record<string, unknown> & { id: string; name: string; coverUrl?: string | null }> }>("/ugc/personas");
  const p = res?.personas?.find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
  if (!p) return undefined;
  if (!p.coverUrl) throw new Error(`${p.name} has no look in Appeeky yet: pick one in Appeeky UGC, or keep the persona in appeeky/ugc/personas/ with its images.`);
  const { coverUrl, referenceAssetIds: _ids, ...rest } = p;
  return { ...(rest as unknown as LocalPersona), looks: [coverUrl] };
}

interface Plan {
  still: PreparedJob;
  video: (stillUrl: string) => PreparedJob;
  costUsd: number;
  clip: { durationSec: number; aspectRatio: string; videoModelId: string };
}

/** The same two steps as the hosted clip render: a still of the persona in the scene, then a talking video. */
export function planLocalClip(core: Core, persona: LocalPersona, brief: Brief, refs: string[]): Plan {
  const script = brief.script.trim();
  if (script.length > core.MAX_SCRIPT_CHARS) throw new Error(`The script is too long for one clip (max ${core.MAX_SCRIPT_CHARS} characters, about 8 seconds of speech).`);
  const model = core.getMediaModel("veo-3.1-fast");
  if (!model) throw new Error("The video model veo-3.1-fast is missing from @appeeky/ugc-core: update it.");
  const durationSec = core.fitDuration(model, brief.durationSec ?? 8);
  const aspectRatio = brief.aspectRatio ?? "9:16";
  const ugcPersona = asUgcPersona(persona);
  const negativePrompt = core.negativesFor(core.buildCreatorLock(ugcPersona), { video: true }).join(", ");
  const scene = (brief.scene ?? "").trim();
  const still = core.prepareImageJob({
    ownerEmail: "",
    modelId: "nano-banana",
    prompt: core.stillPrompt({ persona: ugcPersona, shot: {}, direction: scene || "talking to the camera at home" }),
    imageUrls: refs,
    count: 1,
    aspectRatio,
  });
  const video = (stillUrl: string) =>
    core.prepareVideoJob({
      ownerEmail: "",
      modelId: model.id,
      prompt: core.talkingVideoPrompt({ persona: ugcPersona, shot: {}, direction: scene, script }),
      imageUrl: stillUrl,
      durationSec,
      aspectRatio,
      audio: true,
      negativePrompt,
    });
  const costUsd = Math.round((still.costUsd + video(core.PLACEHOLDER_IMAGE).costUsd) * 10_000) / 10_000;
  return { still, video, costUsd, clip: { durationSec, aspectRatio, videoModelId: model.id } };
}

const CONTENT_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

type Fal = ReturnType<Core["createFalClient"]>;

/** Local look images go to fal storage first, so the models can fetch them. */
async function referenceUrls(fal: Fal, looks: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const look of looks.slice(0, 6)) {
    if (/^https?:\/\//.test(look)) urls.push(look);
    else urls.push(await fal.upload({ data: await readFile(look), contentType: CONTENT_TYPES[extname(look).toLowerCase()] ?? "image/png", fileName: basename(look) }));
  }
  return urls;
}

async function runJob(core: Core, fal: Fal, job: PreparedJob, sleep: (ms: number) => Promise<void>, timeoutMs = 15 * 60_000): Promise<string> {
  const submission = await fal.submit(job.model.endpoint, job.model.mapInput(job.request));
  const started = Date.now();
  for (;;) {
    const s = await fal.status(submission.statusUrl);
    if (s.state === "completed") break;
    if (s.state === "failed") throw new Error(`fal: ${s.error}`);
    if (Date.now() - started > timeoutMs) throw new Error("fal: timed out after 15 minutes");
    await sleep(4000);
  }
  const out = core.extractOutputUrls(await fal.result(submission.responseUrl));
  if (!out[0]) throw new Error("fal returned no media");
  return out[0].url;
}

export interface LocalClipResult {
  file: string;
  videoUrl: string;
  stillUrl: string;
  costUsd: number;
}

/** Make the clip with the user's fal key, save it under .appeeky/media/ and record it in the brief. */
export async function generateLocal(
  core: Core,
  root: string,
  brief: Brief & { file: string },
  persona: LocalPersona,
  falKey: string,
  options: { fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: Date; log?: (line: string) => void } = {},
): Promise<LocalClipResult> {
  const fal = core.createFalClient(falKey);
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  const refs = await referenceUrls(fal, persona.looks);
  const plan = planLocalClip(core, persona, brief, refs);
  log("still: the persona in the scene");
  const stillUrl = await runJob(core, fal, plan.still, sleep);
  log("video: the persona says the script");
  const videoUrl = await runJob(core, fal, plan.video(stillUrl), sleep);
  const res = await (options.fetcher ?? fetch)(videoUrl);
  if (!res.ok) throw new Error(`Could not download the clip: HTTP ${res.status}`);
  await mkdir(mediaDir(root), { recursive: true });
  const file = join(mediaDir(root), `${basename(brief.file, ".yaml")}.mp4`);
  await writeFile(file, new Uint8Array(await res.arrayBuffer()));
  const { file: briefFile, ...rest } = brief;
  const record = { ...rest, status: "generated", clipFile: relative(root, file), videoUrl, costUsd: plan.costUsd, generatedAt: (options.now ?? new Date()).toISOString() };
  await writeFile(briefFile, YAML.stringify(record, { lineWidth: 0 }));
  return { file, videoUrl, stillUrl, costUsd: plan.costUsd };
}
