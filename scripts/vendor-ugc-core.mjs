// Bundles the parts of Appeeky's UGC pipeline that `ugc generate --local` uses into vendor/ugc-core.js:
// one minified file, no sources or source maps. Run it when packages/ugc-core changes, then commit the file.
//   node scripts/vendor-ugc-core.mjs [path to packages/ugc-core]
import { build } from "esbuild";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const core = resolve(process.argv[2] ?? "../appeeky/packages/ugc-core");
if (!existsSync(`${core}/src/index.ts`)) throw new Error(`No ugc-core sources at ${core}`);

const entry = `
export { MAX_SCRIPT_CHARS } from "./src/index.ts";
export { getMediaModel, fitDuration, prepareImageJob, prepareVideoJob, createFalClient, extractOutputUrls } from "./src/media/index.ts";
export { buildCreatorLock, negativesFor, stillPrompt, talkingVideoPrompt } from "./src/prompt-spec/index.ts";
export { PLACEHOLDER_IMAGE } from "./src/studio/index.ts";
`;

await build({
  stdin: { contents: entry, resolveDir: core, loader: "ts", sourcefile: "ugc-core-entry.ts" },
  bundle: true,
  minify: true,
  treeShaking: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  sourcemap: false,
  outfile: "vendor/ugc-core.js",
});
console.log(`vendor/ugc-core.js ${(statSync("vendor/ugc-core.js").size / 1024).toFixed(1)} KB`);
