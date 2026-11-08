// Bundles the AI visibility pipeline that `visibility scan --local` uses into vendor/visibility-core.js:
// core/visibility.ts plus Appeeky's web search answer parsers, one minified file with no sources or maps.
// Run it when core/visibility.ts or the parsers change, then commit the file.
//   node scripts/vendor-visibility-core.mjs [path to the appeeky repo]
import { build } from "esbuild";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const appeeky = resolve(process.argv[2] ?? "../appeeky");
const parsers = `${appeeky}/apps/api/src/services/ai-visibility/web-search-parsers.ts`;
if (!existsSync(parsers)) throw new Error(`No AI visibility parsers at ${parsers}`);

await build({
  entryPoints: ["core/visibility.ts"],
  alias: { "@appeeky/visibility-parsers": parsers },
  nodePaths: [`${appeeky}/apps/api/node_modules`, `${appeeky}/node_modules`],
  bundle: true,
  minify: true,
  treeShaking: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  sourcemap: false,
  outfile: "vendor/visibility-core.js",
});
console.log(`vendor/visibility-core.js ${(statSync("vendor/visibility-core.js").size / 1024).toFixed(1)} KB`);
