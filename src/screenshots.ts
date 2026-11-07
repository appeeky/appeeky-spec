import { existsSync } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_DIR } from "./files.js";
import type { Issue } from "./lint.js";
import type { AppStoreContext } from "./stores/app-store.js";
import type { RemoteState } from "./stores/types.js";
import type { OpsTransport } from "./transport.js";

/**
 * Screenshots live next to the listings:
 * `appeeky/screenshots/app-store/<locale>/<DISPLAY_TYPE>/01.png`.
 * `screenshots pull` downloads the live set; `check` validates sizes and counts.
 */
export function screenshotsDir(root: string): string {
  return join(root, SPEC_DIR, "screenshots", "app-store");
}

/** Portrait sizes App Store Connect accepts per display type (landscape is the same, swapped). */
export const SCREENSHOT_SIZES: Record<string, Array<[number, number]>> = {
  APP_IPHONE_67: [[1290, 2796], [1320, 2868], [1260, 2736]],
  APP_IPHONE_65: [[1242, 2688], [1284, 2778]],
  APP_IPHONE_61: [[1179, 2556], [1206, 2622], [1170, 2532]],
  APP_IPHONE_58: [[1125, 2436], [1080, 2340]],
  APP_IPHONE_55: [[1242, 2208]],
  APP_IPAD_PRO_3GEN_129: [[2048, 2732], [2064, 2752]],
  APP_IPAD_PRO_129: [[2048, 2732]],
  APP_IPAD_PRO_3GEN_11: [[1668, 2388], [1640, 2360]],
};
const MAX_PER_SET = 10;

/** Width and height from a PNG or JPEG header, without decoding the image. */
export async function imageSize(file: string): Promise<{ width: number; height: number } | null> {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Sizes and counts of every screenshot set in the spec. */
export async function checkScreenshots(root: string): Promise<Issue[]> {
  const base = screenshotsDir(root);
  if (!existsSync(base)) return [];
  const issues: Issue[] = [];
  for (const locale of await readdir(base)) {
    const localeDir = join(base, locale);
    if (!(await readdir(localeDir).catch(() => null))) continue;
    for (const type of await readdir(localeDir)) {
      const files = (await readdir(join(localeDir, type)).catch(() => [] as string[])).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
      const at = (severity: Issue["severity"], message: string) =>
        issues.push({ severity, rule: "screenshots", store: "app-store", locale, field: type, message });
      if (files.length > MAX_PER_SET) at("error", `${type} has ${files.length} screenshots; the limit is ${MAX_PER_SET}.`);
      const sizes = SCREENSHOT_SIZES[type];
      if (!sizes) continue;
      for (const f of files) {
        const size = await imageSize(join(localeDir, type, f));
        if (!size) continue;
        const ok = sizes.some(([w, h]) => (size.width === w && size.height === h) || (size.width === h && size.height === w));
        if (!ok) at("error", `${f} is ${size.width}×${size.height}; ${type} takes ${sizes.map(([w, h]) => `${w}×${h}`).join(", ")}.`);
      }
    }
  }
  return issues;
}

interface Res<A> {
  id: string;
  attributes?: A;
}
const list = <A>(doc: unknown): Res<A>[] => {
  const d = (doc as { data?: unknown })?.data;
  return Array.isArray(d) ? (d as Res<A>[]) : [];
};

/** Download the live App Store screenshots of every locale into the spec. */
export async function pullScreenshots(
  root: string,
  transport: OpsTransport,
  state: RemoteState,
  options: { locales?: string[]; fetcher?: typeof fetch } = {},
): Promise<number> {
  const ctx = state.context as AppStoreContext;
  const doFetch = options.fetcher ?? fetch;
  let count = 0;
  for (const [locale, localizationId] of Object.entries(ctx.versionLocIds)) {
    if (options.locales && !options.locales.includes(locale)) continue;
    const sets = list<{ screenshotDisplayType?: string }>(await transport.call("appstore_list_screenshot_sets", { localizationId, limit: 50 }));
    for (const set of sets) {
      const type = set.attributes?.screenshotDisplayType ?? "UNKNOWN";
      const shots = list<{ fileName?: string; imageAsset?: { templateUrl?: string; width?: number; height?: number } }>(
        await transport.call("appstore_list_screenshots", { setId: set.id, limit: 50 }),
      );
      const dir = join(screenshotsDir(root), locale, type);
      await mkdir(dir, { recursive: true });
      for (const [i, shot] of shots.entries()) {
        const asset = shot.attributes?.imageAsset;
        if (!asset?.templateUrl || !asset.width || !asset.height) continue;
        const url = asset.templateUrl.replace("{w}", String(asset.width)).replace("{h}", String(asset.height)).replace("{f}", "png");
        const res = await doFetch(url);
        if (!res.ok) continue;
        await writeFile(join(dir, `${String(i + 1).padStart(2, "0")}.png`), Buffer.from(await res.arrayBuffer()));
        count++;
      }
    }
  }
  return count;
}
