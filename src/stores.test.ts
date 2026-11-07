import { describe, expect, it } from "vitest";
import { diffListings, invertChanges } from "./diff.js";
import { AppStoreAdapter } from "./stores/app-store.js";
import { GooglePlayAdapter } from "./stores/google-play.js";
import type { AppStoreListing, GooglePlayListing } from "./schema.js";
import { fakeTransport } from "./test-helpers.js";

type AS = Record<string, AppStoreListing>;
type GP = Record<string, GooglePlayListing>;

const versions = (state: string) => ({
  data: [
    { id: "v-old", attributes: { versionString: "2.2", appVersionState: "READY_FOR_DISTRIBUTION", createdDate: "2026-01-01" } },
    { id: "v-new", attributes: { versionString: "2.3", appVersionState: state, createdDate: "2026-09-01" } },
  ],
});

function ascAnswers(versionState: string, infoState: string) {
  return {
    appstore_list_versions: versions(versionState),
    appstore_list_app_infos: { data: [{ id: "info-1", attributes: { state: infoState } }] },
    appstore_list_version_localizations: {
      data: [{ id: "vl-en", attributes: { locale: "en-US", keywords: "rain,storm", promotionalText: "Old promo", description: "Desc", whatsNew: null } }],
    },
    appstore_list_app_info_localizations: { data: [{ id: "il-en", attributes: { locale: "en-US", name: "Sleep", subtitle: "Old subtitle" } }] },
    appstore_update_app_info_localization: { data: {} },
    appstore_update_version_localization: { data: {} },
    appstore_create_app_info_localization: { data: { id: "il-de" } },
    appstore_create_version_localization: { data: { id: "vl-de" } },
  };
}

describe("diffListings", () => {
  it("diffs only managed fields and ignores whitespace noise", () => {
    const local: AS = { "en-US": { name: "Sleep", subtitle: "New", description: "Line\r\nTwo  " }, "de-DE": { name: "Schlaf" } };
    const remote: AS = { "en-US": { name: "Sleep", subtitle: "Old", description: "Line\nTwo", keywords: "a" } };
    const changes = diffListings("app-store", local, remote);
    expect(changes.map((c) => `${c.locale}.${c.field}:${c.newLocale}`)).toEqual(["en-US.subtitle:false", "de-DE.name:true"]);
    expect(invertChanges(changes)).toEqual([
      expect.objectContaining({ locale: "en-US", field: "subtitle", after: "Old", before: "New" }),
      expect.objectContaining({ locale: "de-DE", field: "name", after: "" }),
    ]);
    // "" clears a field the store has, and is no change when the store has none.
    expect(diffListings("app-store", { "en-US": { promotionalText: "" } }, { "en-US": { promotionalText: "Sale" } })).toHaveLength(1);
    expect(diffListings("app-store", { "en-US": { promotionalText: "" } }, { "en-US": {} })).toHaveLength(0);
  });
});

describe("AppStoreAdapter", () => {
  it("pulls the editable version and app info into listings", async () => {
    const t = fakeTransport(ascAnswers("PREPARE_FOR_SUBMISSION", "PREPARE_FOR_SUBMISSION"));
    const state = await new AppStoreAdapter(t, "123").pull();
    expect(state.listings).toEqual({
      "en-US": { name: "Sleep", subtitle: "Old subtitle", keywords: "rain,storm", promotionalText: "Old promo", description: "Desc" },
    });
    expect(state.target).toBe("version 2.3 (prepare for submission)");
    expect(t.calls.find((c) => c.op === "appstore_list_version_localizations")?.args).toMatchObject({ versionId: "v-new" });
  });

  it("pushes updates and creates new locales with one call per resource", async () => {
    const t = fakeTransport(ascAnswers("PREPARE_FOR_SUBMISSION", "PREPARE_FOR_SUBMISSION"));
    const adapter = new AppStoreAdapter(t, "123");
    const state = await adapter.pull();
    const local: AS = {
      "en-US": { name: "Sleep", subtitle: "Rain & white noise", keywords: "rain,storm,fan" },
      "de-DE": { name: "Schlafen", keywords: "regen" },
    };
    const result = await adapter.push(diffListings("app-store", local, state.listings), state, local);
    expect(result.skipped).toEqual([]);
    const writes = t.calls.filter((c) => c.write).map((c) => [c.op, c.args]);
    expect(writes).toEqual([
      ["appstore_update_app_info_localization", { localizationId: "il-en", subtitle: "Rain & white noise" }],
      ["appstore_update_version_localization", { localizationId: "vl-en", keywords: "rain,storm,fan" }],
      ["appstore_create_app_info_localization", { appInfoId: "info-1", locale: "de-DE", name: "Schlafen" }],
      ["appstore_create_version_localization", { versionId: "v-new", locale: "de-DE", keywords: "regen" }],
    ]);
  });

  it("only lets promotional text through when no version is editable", async () => {
    const t = fakeTransport(ascAnswers("READY_FOR_DISTRIBUTION", "READY_FOR_DISTRIBUTION"));
    const adapter = new AppStoreAdapter(t, "123");
    const state = await adapter.pull();
    const local: AS = { "en-US": { subtitle: "New", keywords: "fan", promotionalText: "New promo" } };
    const result = await adapter.push(diffListings("app-store", local, state.listings), state, local);
    expect(result.applied.map((c) => c.field)).toEqual(["promotionalText"]);
    expect(result.skipped.map((c) => c.field)).toEqual(["subtitle", "keywords"]);
    expect(result.skipped[0]!.blocked).toMatch(/new version/);
    expect(t.calls.filter((c) => c.write).map((c) => c.args)).toEqual([{ localizationId: "vl-en", promotionalText: "New promo" }]);
  });
});

describe("GooglePlayAdapter", () => {
  const answers = {
    gps_list_listings: [{ language: "en-US", title: "Sleep", shortDescription: "Old", fullDescription: "Full", video: null }],
    gps_update_listing: {},
  };

  it("pulls listings and patches only changed fields", async () => {
    const t = fakeTransport(answers);
    const adapter = new GooglePlayAdapter(t, "com.example.sleep");
    const state = await adapter.pull();
    expect(state.listings).toEqual({ "en-US": { title: "Sleep", shortDescription: "Old", fullDescription: "Full" } });
    const local: GP = { "en-US": { shortDescription: "Rain sounds & white noise" } };
    await adapter.push(diffListings("google-play", local, state.listings), state, local);
    expect(t.calls.at(-1)).toEqual({
      op: "gps_update_listing",
      args: { packageName: "com.example.sleep", language: "en-US", shortDescription: "Rain sounds & white noise" },
      write: true,
    });
  });

  it("requires the full listing for a new language", async () => {
    const t = fakeTransport(answers);
    const adapter = new GooglePlayAdapter(t, "com.example.sleep");
    const state = await adapter.pull();
    const local: GP = { "tr-TR": { title: "Uyku" } };
    const result = await adapter.push(diffListings("google-play", local, state.listings), state, local);
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]!.blocked).toMatch(/shortDescription, fullDescription/);
  });
});
