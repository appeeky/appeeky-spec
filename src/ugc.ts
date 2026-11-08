import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppeekyApi } from "./appeeky-api.js";
import { SPEC_DIR, SpecError } from "./files.js";

/**
 * UGC from Appeeky's creator personas, in the repo (APPEEKY_API_KEY):
 *
 *   appeeky/ugc/personas.yaml        the creator personas: who they are, their lane and platforms
 *   appeeky/ugc/clips.jsonl          the clips made with them: script, caption, status, where posted
 *   appeeky/ugc/briefs/<name>.yaml   a video to make: drafted, reviewed in a pull request, then generated
 *
 * Generating a clip uses Appeeky media credits, so it only runs when a person asks for it.
 */

export const ugcDir = (root: string) => join(root, SPEC_DIR, "ugc");
export const briefsDir = (root: string) => join(ugcDir(root), "briefs");

export interface Persona {
  id: string;
  name: string;
  status?: string;
  bio?: string;
  lane?: string;
  platforms?: string[];
  contentPillars?: string[];
  /** Clips need a look (reference images) picked in Appeeky first. */
  ready: boolean;
}

export interface Clip {
  id: string;
  persona: string;
  status: string;
  title?: string;
  script?: string;
  caption?: string;
  durationSec?: number;
  aspectRatio?: string;
  scheduledFor?: string;
  socialPostId?: string;
  error?: string;
  createdAt: string;
}

interface PersonaRow {
  id: string;
  name: string;
  status?: string;
  bio?: string;
  lane?: string;
  platforms?: string[];
  contentPillars?: string[];
  referenceAssetIds?: string[];
}

interface ClipRow {
  id: string;
  personaId: string;
  status: string;
  title?: string;
  script?: string;
  caption?: string;
  durationSec?: number;
  aspectRatio?: string;
  scheduledFor?: string | null;
  socialPostId?: string | null;
  error?: string | null;
  createdAt: string;
}

const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))) as T;

export function toPersona(r: PersonaRow): Persona {
  return { ...compact({ id: r.id, name: r.name, status: r.status, bio: r.bio, lane: r.lane, platforms: r.platforms, contentPillars: r.contentPillars }), ready: (r.referenceAssetIds?.length ?? 0) > 0 };
}

/** Signed media URLs expire within hours, so clips are stored without them. */
export function toClip(r: ClipRow, personas: Persona[]): Clip {
  return compact({
    id: r.id,
    persona: personas.find((p) => p.id === r.personaId)?.name ?? r.personaId,
    status: r.status,
    title: r.title,
    script: r.script,
    caption: r.caption,
    durationSec: r.durationSec,
    aspectRatio: r.aspectRatio,
    scheduledFor: r.scheduledFor ?? undefined,
    socialPostId: r.socialPostId ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.createdAt,
  });
}

export async function fetchUgc(api: AppeekyApi, options: { limit?: number } = {}): Promise<{ personas: Persona[]; clips: Clip[] }> {
  const personas = ((await api.get<{ personas: PersonaRow[] }>("/ugc/personas"))?.personas ?? []).map(toPersona);
  const clips = ((await api.get<{ clips: ClipRow[] }>("/ugc/clips", { limit: String(options.limit ?? 100) }))?.clips ?? []).map((c) => toClip(c, personas));
  return { personas, clips };
}

export async function saveUgc(root: string, data: { personas: Persona[]; clips: Clip[] }): Promise<void> {
  await mkdir(ugcDir(root), { recursive: true });
  await writeFile(join(ugcDir(root), "personas.yaml"), YAML.stringify({ personas: data.personas }, { lineWidth: 0 }));
  await writeFile(join(ugcDir(root), "clips.jsonl"), data.clips.map((c) => JSON.stringify(c)).join("\n") + (data.clips.length ? "\n" : ""));
}

export async function readPersonas(root: string): Promise<Persona[]> {
  const file = join(ugcDir(root), "personas.yaml");
  if (!existsSync(file)) return [];
  return ((YAML.parse(await readFile(file, "utf8")) as { personas?: Persona[] } | null)?.personas ?? []) as Persona[];
}

// ── Briefs ──────────────────────────────────────────────────────────────────

export const briefSchema = z
  .object({
    /** A persona name or id from personas.yaml. */
    persona: z.string().min(1),
    /** What the creator says, word for word. */
    script: z.string().min(1),
    /** Where it is filmed and what is on screen. */
    scene: z.string().optional(),
    caption: z.string().optional(),
    title: z.string().optional(),
    durationSec: z.number().int().positive().optional(),
    aspectRatio: z.enum(["9:16", "16:9"]).optional(),
    /** The hypothesis, for whoever reviews the pull request: which hook, for whom, measured how. */
    why: z.string().optional(),
    status: z.enum(["draft", "generating", "generated"]).default("draft"),
    clipId: z.string().optional(),
    credits: z.number().optional(),
    generatedAt: z.string().optional(),
    /** Made locally with --local: the file under .appeeky/media/, fal's URL for it and what fal charged. */
    clipFile: z.string().optional(),
    videoUrl: z.string().url().optional(),
    costUsd: z.number().optional(),
  })
  .strict();

export type Brief = z.infer<typeof briefSchema>;

export async function readBriefs(root: string): Promise<Array<Brief & { file: string }>> {
  const dir = briefsDir(root);
  if (!existsSync(dir)) return [];
  const out: Array<Brief & { file: string }> = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort()) {
    const parsed = briefSchema.safeParse(YAML.parse(await readFile(join(dir, f), "utf8")));
    if (!parsed.success) throw new SpecError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), join(dir, f));
    out.push({ ...parsed.data, file: join(dir, f) });
  }
  return out;
}

export function findPersona(brief: Brief, personas: Persona[]): Persona | undefined {
  const ref = brief.persona.toLowerCase();
  return personas.find((p) => p.id === brief.persona || p.name.toLowerCase() === ref);
}

function clipBody(brief: Brief) {
  return compact({ script: brief.script, scene: brief.scene, caption: brief.caption, title: brief.title, durationSec: brief.durationSec, aspectRatio: brief.aspectRatio });
}

/** What the clip would cost in media credits, without making it. */
export async function quoteBrief(api: AppeekyApi, brief: Brief, persona: Persona): Promise<{ credits: number; available: number; affordable: boolean }> {
  return api.post(`/ugc/personas/${encodeURIComponent(persona.id)}/clips`, { ...clipBody(brief), dryRun: true });
}

/** Start rendering the clip (uses media credits) and record it in the brief. */
export async function generateBrief(api: AppeekyApi, brief: Brief & { file: string }, persona: Persona, now = new Date()): Promise<{ clipId: string; credits: number }> {
  const res = await api.post<{ clip: { id: string }; credits: number }>(`/ugc/personas/${encodeURIComponent(persona.id)}/clips`, clipBody(brief));
  const { file, ...rest } = brief;
  await writeFile(file, YAML.stringify({ ...rest, status: "generating", clipId: res.clip.id, credits: res.credits, generatedAt: now.toISOString() }, { lineWidth: 0 }));
  return { clipId: res.clip.id, credits: res.credits };
}
