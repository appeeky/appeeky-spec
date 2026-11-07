import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { run } from "./cli.js";

/**
 * A stand-in for the `appstore` CLI: answers `--json [--confirm] ops call <op> <args>`
 * from a JSON file and applies writes to it, so the real command flow runs end to end.
 */
const FAKE_APPSTORE = `#!/usr/bin/env node
const fs = require("fs");
const file = process.env.FAKE_ASC_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
const i = argv.indexOf("call");
const op = argv[i + 1];
const args = JSON.parse(argv[i + 2] || "{}");
const write = argv.includes("--confirm");
const out = (v) => process.stdout.write(JSON.stringify(v));
const loc = (kind, id) => state[kind].find((l) => l.id === id);
switch (op) {
  case "appstore_list_versions": out({ data: state.versions }); break;
  case "appstore_list_app_infos": out({ data: state.appInfos }); break;
  case "appstore_list_version_localizations": out({ data: state.versionLocs }); break;
  case "appstore_list_app_info_localizations": out({ data: state.appInfoLocs }); break;
  case "appstore_update_version_localization":
  case "appstore_update_app_info_localization": {
    if (!write) { process.stderr.write("Error: writes need --confirm"); process.exit(1); }
    const kind = op.includes("app_info") ? "appInfoLocs" : "versionLocs";
    const { localizationId, ...attrs } = args;
    Object.assign(loc(kind, localizationId).attributes, attrs);
    fs.writeFileSync(file, JSON.stringify(state));
    out({ data: { id: localizationId } });
    break;
  }
  default: process.stderr.write("Unknown op " + op); process.exit(1);
}
`;

const INITIAL = {
  versions: [{ id: "v1", attributes: { versionString: "2.4", appVersionState: "PREPARE_FOR_SUBMISSION", createdDate: "2026-10-01" } }],
  appInfos: [{ id: "i1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }],
  versionLocs: [{ id: "vl1", attributes: { locale: "en-US", keywords: "rain, storm,sleep", promotionalText: "Sleep better", description: "Rain sounds." } }],
  appInfoLocs: [{ id: "il1", attributes: { locale: "en-US", name: "Sleep Sounds", subtitle: "Calm sleep" } }],
};

describe("appeeky-spec CLI", () => {
  let dir: string;
  let stateFile: string;
  let out: string[];
  const oldEnv = { ...process.env };

  const cli = async (...args: string[]) => {
    out = [];
    process.exitCode = undefined;
    await run(["node", "appeeky-spec", "--cwd", dir, "--json", ...args]);
    const text = out.join("");
    return { json: text ? JSON.parse(text) : undefined, code: process.exitCode ?? 0 };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-e2e-"));
    const bin = mkdtempSync(join(tmpdir(), "spec-e2e-bin-"));
    writeFileSync(join(bin, "appstore"), FAKE_APPSTORE);
    chmodSync(join(bin, "appstore"), 0o755);
    stateFile = join(bin, "state.json");
    writeFileSync(stateFile, JSON.stringify(INITIAL));
    process.env.PATH = `${bin}:${oldEnv.PATH}`;
    process.env.FAKE_ASC_STATE = stateFile;
    delete process.env.APPEEKY_API_KEY;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...oldEnv };
    process.exitCode = undefined;
  });

  it("goes from init to a pushed, logged and reverted release", async () => {
    await cli("init", "--name", "Sleep Sounds", "--app-store", "123");
    const spec = YAML.parse(await readFile(join(dir, "appeeky.spec.yaml"), "utf8"));
    expect(spec.stores.appStore).toEqual({ appId: "123", via: "auto" });

    const pulled = await cli("pull");
    expect(pulled.json.written).toHaveLength(1);
    const listingFile = join(dir, "appeeky/store/app-store/en-US.yaml");
    expect(YAML.parse(await readFile(listingFile, "utf8"))).toEqual({
      name: "Sleep Sounds",
      subtitle: "Calm sleep",
      keywords: "rain, storm,sleep",
      promotionalText: "Sleep better",
      description: "Rain sounds.",
    });

    const checked = await cli("check");
    expect(checked.json.issues.map((i: { rule: string }) => i.rule)).toEqual(
      expect.arrayContaining(["subtitle/repeats-name", "keywords/spaces", "keywords/duplicate-of-name"]),
    );
    expect(checked.code).toBe(0);

    spec.targets = { us: ["sleep sounds", "white noise", "rain"] };
    await writeFile(join(dir, "appeeky.spec.yaml"), YAML.stringify(spec));
    const coverage = await cli("coverage", "--no-metrics");
    expect(coverage.json.coverage[0]).toMatchObject({ store: "app-store", country: "us", covered: 2, total: 3 });

    await writeFile(listingFile, YAML.stringify({ name: "Sleep Sounds", subtitle: "White noise & rain", keywords: "storm,fan,thunder" }));
    const diff = await cli("diff");
    expect(diff.json.stores[0].changes.map((c: { field: string }) => c.field)).toEqual(["subtitle", "keywords"]);

    const refused = await cli("push", "--no-baseline");
    expect(refused.code).toBe(1);

    const pushed = await cli("push", "--yes", "--no-baseline", "--note", "Lead with white noise");
    expect(pushed.json.releases[0].changes).toHaveLength(2);
    const live = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(live.appInfoLocs[0].attributes.subtitle).toBe("White noise & rain");
    expect(live.versionLocs[0].attributes.keywords).toBe("storm,fan,thunder");
    expect((await cli("diff")).json.stores[0].changes).toEqual([]);

    const log = await cli("log");
    expect(log.json.releases[0]).toMatchObject({ store: "app-store", note: "Lead with white noise", target: "version 2.4 (prepare for submission)" });
    expect(await readdir(join(dir, "appeeky/releases"))).toHaveLength(1);

    await cli("revert", log.json.releases[0].id);
    expect(YAML.parse(await readFile(listingFile, "utf8"))).toMatchObject({ subtitle: "Calm sleep", keywords: "rain, storm,sleep" });
  });

  it("refuses to push when check finds errors", async () => {
    await cli("init", "--app-store", "123");
    await cli("pull");
    await writeFile(join(dir, "appeeky/store/app-store/en-US.yaml"), YAML.stringify({ name: "x".repeat(40) }));
    const result = await cli("push", "--yes", "--no-baseline");
    expect(result.code).toBe(1);
    expect(result.json.error).toBe("check_failed");
  });

  it("explains a missing spec", async () => {
    const result = await cli("check");
    expect(result.code).toBe(1);
    expect(result.json.error).toMatch(/appeeky-spec init/);
  });
});
