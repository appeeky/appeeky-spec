import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedStorefronts, compareWithControl } from "./control.js";
import { writeRelease, type ReleaseRecord } from "./history.js";
import { verifyReleases } from "./measure.js";
import { makeProject } from "./test-helpers.js";

const listing = { name: "Sleep", subtitle: "Rain", keywords: "rain" };
const project = makeProject({}, { "en-US": listing, "de-DE": listing, tr: listing });
const release: ReleaseRecord = {
  id: "r",
  pushedAt: "2026-10-28T10:00:00Z",
  store: "app-store",
  target: "3.2",
  via: "test",
  changes: [{ locale: "en-US", field: "subtitle", before: "Calm", after: "Rain" }],
};

describe("control storefronts", () => {
  it("splits the baseline into storefronts that read the changed locale and ones that do not", () => {
    expect(changedStorefronts(project, release, ["us", "de", "tr"])).toEqual(["us"]);
  });

  it("takes the store-wide move out", () => {
    const before = { us: { a: 30, b: 40, c: 50 }, de: { d: 30, e: 40, f: 50 } };
    // Everything rose about 10 places; the US only 1 more than Germany.
    const after = { us: { a: 19, b: 29, c: 39 }, de: { d: 20, e: 30, f: 40 } };
    expect(compareWithControl(project, release, before, after)).toEqual({ changed: ["us"], control: ["de"], changedMove: 11, controlMove: 10, net: 1 });
  });

  it("needs a few targets on both sides", () => {
    expect(compareWithControl(project, release, { us: { a: 30 }, de: { d: 30 } }, { us: { a: 20 }, de: { d: 30 } })).toBeNull();
  });
});

describe("verify with a control group", () => {
  it("calls a store-wide lift mixed, not won", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-control-"));
    const p = { ...project, root };
    const pushedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const before = { us: { a: 30, b: 40, c: 50 }, de: { d: 30, e: 40, f: 50 } };
    await writeRelease(root, { ...release, id: "r1", pushedAt, baseline: { at: pushedAt, source: "test", ranks: before } });
    const after: Record<string, Record<string, number>> = { us: { a: 19, b: 29, c: 39 }, de: { d: 20, e: 30, f: 40 } };
    const [result] = await verifyReleases(p, { label: "test", ranks: async (_s, _id, cc) => after[cc]! });
    expect(result!.check).toMatchObject({ verdict: "mixed", control: { net: 1 } });
    expect(result!.check.note).toContain("the store moved, not the listing");
  });
});
