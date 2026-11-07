import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppeekyApi } from "./appeeky-api.js";
import { competitorChanges, pullCompetitors, type CompetitorFile } from "./competitors.js";
import { specFileSchema } from "./schema.js";

const file = (store: Partial<CompetitorFile["stores"]["app-store"]>): CompetitorFile => ({
  name: "Calm Night",
  pulledAt: "2026-11-01",
  country: "us",
  stores: { "app-store": { id: "1", ranks: [], yourTargets: [], ...store } },
});

describe("competitor changes", () => {
  it("notices a new title, a new version, a rewrite and a climb on your targets", () => {
    const prev = file({ title: "Calm Night", version: "5.1", description: "Old", yourTargets: [{ keyword: "fan sounds", rank: 14 }] });
    const next = file({ title: "Calm Night: Rain", version: "5.2", releaseNotes: "Fan and AC sounds", description: "New", yourTargets: [{ keyword: "fan sounds", rank: 3 }] });
    expect(competitorChanges(prev, next)).toEqual([
      'App Store: title "Calm Night" → "Calm Night: Rain"',
      "App Store: version 5.2: Fan and AC sounds",
      "App Store: rewrote the description",
      'App Store: now #3 for "fan sounds" (was #14)',
    ]);
    expect(competitorChanges(prev, prev)).toEqual([]);
  });

  it("records them in changes.md on the next pull", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-rivals-"));
    const spec = specFileSchema.parse({ version: 1, app: { name: "x" }, stores: { appStore: { appId: "9" } }, targets: { us: ["fan sounds"] }, competitors: [{ name: "Calm Night", appStore: "1" }] });
    let title = "Calm Night";
    const api = { get: async (path: string) => (path === "/apps/1" ? { title } : null) } as unknown as AppeekyApi;
    await pullCompetitors(api, root, spec, new Date("2026-11-01T00:00:00Z"));
    title = "Calm Night: Rain Sounds";
    const [result] = await pullCompetitors(api, root, spec, new Date("2026-11-02T00:00:00Z"));
    expect(result!.changes).toEqual(['App Store: title "Calm Night" → "Calm Night: Rain Sounds"']);
    expect(readFileSync(join(root, "appeeky", "competitors", "changes.md"), "utf8")).toContain('- 2026-11-02 · Calm Night · App Store: title "Calm Night" → "Calm Night: Rain Sounds"');
  });
});
