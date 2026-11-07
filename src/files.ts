import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import type { ZodType } from "zod";
import {
  appStoreListingSchema,
  fieldsFor,
  googlePlayListingSchema,
  specFileSchema,
  STORES,
  type Listing,
  type Project,
  type SpecFile,
  type SpecFileInput,
  type StoreId,
} from "./schema.js";

export const SPEC_FILE = "appeeky.spec.yaml";
export const SPEC_DIR = "appeeky";

export class SpecError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = "SpecError";
  }
}

export function listingsDir(root: string, store: StoreId): string {
  return join(root, SPEC_DIR, "store", store);
}

export function listingPath(root: string, store: StoreId, locale: string): string {
  return join(listingsDir(root, store), `${locale}.yaml`);
}

/** Walk up from `start` to the folder that holds `appeeky.spec.yaml`. */
export function findRoot(start = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, SPEC_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parse<T>(schema: ZodType<T, any, any>, raw: unknown, file: string): T {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new SpecError(detail, file);
  }
  return result.data;
}

async function readYaml(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  try {
    return YAML.parse(text);
  } catch (err) {
    throw new SpecError((err as Error).message, file);
  }
}

export function parseSpec(raw: unknown, file = SPEC_FILE): SpecFile {
  return parse(specFileSchema, raw, file);
}

export function parseListing(store: StoreId, raw: unknown, file: string): Listing {
  return store === "app-store" ? parse(appStoreListingSchema, raw, file) : parse(googlePlayListingSchema, raw, file);
}

/** Load the spec and every listing file under `appeeky/store/`. */
export async function loadProject(start?: string): Promise<Project> {
  const root = findRoot(start);
  if (!root) throw new SpecError(`No ${SPEC_FILE} found here or in a parent folder. Run \`appeeky-spec init\` first.`);
  const spec = parseSpec(await readYaml(join(root, SPEC_FILE)), join(root, SPEC_FILE));
  const project: Project = { root, spec, listings: { "app-store": {}, "google-play": {} } };
  for (const store of STORES) {
    const dir = listingsDir(root, store);
    if (!existsSync(dir)) continue;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
    for (const f of files) {
      const locale = f.replace(/\.ya?ml$/, "");
      const file = join(dir, f);
      (project.listings[store] as Record<string, Listing>)[locale] = parseListing(store, await readYaml(file), file);
    }
  }
  return project;
}

/** Keep the store's field order and use block scalars for multi-line text so diffs stay readable. */
export function stringifyListing(store: StoreId, listing: Listing): string {
  const ordered: Record<string, string> = {};
  for (const field of fieldsFor(store)) {
    const value = (listing as Record<string, string | undefined>)[field];
    if (value !== undefined) ordered[field] = value;
  }
  return YAML.stringify(ordered, { lineWidth: 0, blockQuote: "literal" });
}

export async function writeListing(root: string, store: StoreId, locale: string, listing: Listing): Promise<string> {
  const file = listingPath(root, store, locale);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringifyListing(store, listing));
  return file;
}

export function stringifySpec(spec: SpecFileInput): string {
  // Optional sections stay out of the file until they have content.
  const clean: Record<string, unknown> = { ...spec };
  for (const k of ["storefronts", "personas"] as const) {
    const v = clean[k];
    if (v === undefined || (Array.isArray(v) ? v.length === 0 : Object.keys(v as object).length === 0)) delete clean[k];
  }
  const doc = new YAML.Document(clean);
  doc.commentBefore =
    " Appeeky Spec: your app's store presence as a spec.\n Docs: https://github.com/appeeky/appeeky-spec";
  return doc.toString({ lineWidth: 0 });
}

export async function writeSpec(root: string, spec: SpecFileInput): Promise<string> {
  const file = join(root, SPEC_FILE);
  await writeFile(file, stringifySpec(spec));
  return file;
}

/** Where each store's listing files were last pulled from, e.g. "version 3.0.1 (prepare for submission)". */
export type PullState = Partial<Record<StoreId, { target: string; at: string }>>;

const PULL_STATE = join(".appeeky", "pulled.json");

export async function readPullState(root: string): Promise<PullState> {
  const file = join(root, PULL_STATE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf8")) as PullState;
  } catch {
    return {};
  }
}

export async function recordPull(root: string, store: StoreId, target: string): Promise<void> {
  const state = { ...(await readPullState(root)), [store]: { target, at: new Date().toISOString() } };
  const file = join(root, PULL_STATE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
