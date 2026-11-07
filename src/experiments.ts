import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SPEC_DIR, SpecError } from "./files.js";
import { isMetricName, outcomeOf } from "./metrics.js";

/**
 * Anything you try to grow the app that is not a listing push: screenshots,
 * a UGC hook, an ad creative, a price. Same shape as a release: a hypothesis,
 * one metric, a baseline, a date to check, and a result.
 * Listing pushes are experiments already (their release file holds the result).
 */
export const experimentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    type: z.enum(["screenshots", "ugc", "ads", "pricing", "other"]),
    hypothesis: z.string().min(1),
    /** Persona id from `personas:` in appeeky.spec.yaml. */
    persona: z.string().optional(),
    store: z.enum(["app-store", "google-play"]).optional(),
    country: z.string().optional(),
    metric: z.string().min(1),
    baseline: z.number().optional(),
    /** Value that counts as a win, e.g. 2.5 for "install_per_1k_views > 2.5". */
    target: z.number().optional(),
    startedAt: z.string(),
    checkAfterDays: z.number().int().positive().default(14),
    status: z.enum(["running", "won", "lost", "inconclusive"]).default("running"),
    result: z.object({ value: z.number().optional(), note: z.string().optional(), closedAt: z.string() }).optional(),
    /** The smart link that carries the experiment's traffic, so its installs and revenue are counted exactly. */
    link: z.object({ slug: z.string(), url: z.string().optional(), store: z.enum(["app-store", "google-play"]).optional() }).strict().optional(),
    /** Links, file paths, ad ids: whatever ran. */
    assets: z.array(z.string()).default([]),
  })
  .strict();

export type Experiment = z.infer<typeof experimentSchema>;
export type ExperimentInput = z.input<typeof experimentSchema>;

export function experimentsDir(root: string): string {
  return join(root, SPEC_DIR, "experiments");
}

export async function readExperiments(root: string): Promise<Experiment[]> {
  const dir = experimentsDir(root);
  if (!existsSync(dir)) return [];
  const out: Experiment[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort().reverse()) {
    const parsed = experimentSchema.safeParse(YAML.parse(await readFile(join(dir, f), "utf8")));
    if (!parsed.success) throw new SpecError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), join(dir, f));
    out.push(parsed.data);
  }
  return out;
}

export async function writeExperiment(root: string, input: ExperimentInput): Promise<Experiment> {
  const experiment = experimentSchema.parse(input);
  await mkdir(experimentsDir(root), { recursive: true });
  await writeFile(join(experimentsDir(root), `${experiment.id}.yaml`), YAML.stringify(experiment, { lineWidth: 0 }));
  return experiment;
}

export function experimentId(date: Date, hypothesis: string): string {
  const slug = hypothesis.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "experiment";
  return `${date.toISOString().slice(0, 10)}-${slug}`;
}

/** Experiments whose check date has passed and that have no result yet. */
export function dueExperiments(experiments: Experiment[], now = new Date()): Experiment[] {
  return experiments.filter((e) => e.status === "running" && Date.parse(e.startedAt) + e.checkAfterDays * 86_400_000 <= now.getTime());
}

/**
 * Close with a measured value. With a `target`, reaching it wins. Without
 * one, a known metric (conversion, revenue, cpa, ...) is judged against the
 * baseline: a 5% move the right way wins, the wrong way loses. Anything else
 * is inconclusive.
 */
export function closeExperiment(e: Experiment, value: number | undefined, note: string | undefined, now = new Date()): Experiment {
  let status: Experiment["status"] = "inconclusive";
  if (value !== undefined && e.target !== undefined) {
    const lowerIsBetter = isMetricName(e.metric) && outcomeOf(e.metric, -1) === "better";
    status = (lowerIsBetter ? value <= e.target : value >= e.target) ? "won" : "lost";
  } else if (value !== undefined && e.baseline !== undefined && e.baseline > 0 && isMetricName(e.metric)) {
    const outcome = outcomeOf(e.metric, value / e.baseline - 1);
    status = outcome === "better" ? "won" : outcome === "worse" ? "lost" : "inconclusive";
  }
  return { ...e, status, result: { value, note, closedAt: now.toISOString() } };
}
