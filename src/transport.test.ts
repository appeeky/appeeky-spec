import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTransport, HostedTransport, LocalCliTransport, type Runner } from "./transport.js";

describe("LocalCliTransport", () => {
  it("calls the store CLI with --json, the account and --confirm for writes", async () => {
    const seen: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { code: 0, stdout: '{"data":[]}', stderr: "" };
    };
    const t = new LocalCliTransport("app-store", { account: "studio", runner });
    expect(await t.call("appstore_list_versions", { appId: "1" })).toEqual({ data: [] });
    await t.call("appstore_update_version_localization", { localizationId: "x", keywords: "a" }, { write: true });
    expect(seen).toEqual([
      ["appstore", "--json", "--account", "studio", "ops", "call", "appstore_list_versions", '{"appId":"1"}'],
      ["appstore", "--json", "--account", "studio", "--confirm", "ops", "call", "appstore_update_version_localization", '{"localizationId":"x","keywords":"a"}'],
    ]);
  });

  it("uses `gps call` for Google Play and surfaces CLI errors", async () => {
    const runner: Runner = async () => ({ code: 1, stdout: "", stderr: "Error: Not authenticated" });
    const t = new LocalCliTransport("google-play", { runner });
    await expect(t.call("gps_list_listings", { packageName: "a.b" })).rejects.toThrow(/gps gps_list_listings failed: Error: Not authenticated/);
  });
});

describe("LocalCliTransport with a bundled CLI", () => {
  it("runs the given executable with credentials in the environment", async () => {
    const seen: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    const runner: Runner = async (cmd, args, env) => {
      seen.push({ cmd, args, env });
      return { code: 0, stdout: "[]", stderr: "" };
    };
    const t = new LocalCliTransport("google-play", {
      command: { file: "/Applications/Appeeky.app/electron", args: ["/bundle/gps/bin.js"] },
      env: { ELECTRON_RUN_AS_NODE: "1", GPS_CREDENTIALS: "{}" },
      label: "Appeeky Desktop",
      runner,
    });
    await t.call("gps_list_listings", { packageName: "a.b" });
    expect(t.label).toBe("Appeeky Desktop");
    expect(seen[0]).toEqual({
      cmd: "/Applications/Appeeky.app/electron",
      args: ["/bundle/gps/bin.js", "--json", "call", "gps_list_listings", '{"packageName":"a.b"}'],
      env: { ELECTRON_RUN_AS_NODE: "1", GPS_CREDENTIALS: "{}" },
    });
  });
});

describe("HostedTransport", () => {
  it("posts to /v1/ops with the API key and the write header", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = new HostedTransport("google-play", "apk_test", { fetcher });
    expect(await t.call("gps_update_listing", { language: "en-US" }, { write: true })).toEqual({ ok: true });
    expect(requests[0]!.url).toBe("https://gps-api.appeeky.com/v1/ops/gps_update_listing");
    expect(requests[0]!.init.headers).toMatchObject({ Authorization: "Bearer apk_test", "X-GPS-Allow-Writes": "true" });
  });

  it("reports the gateway's error message", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: { code: "WRITES_DISABLED", message: "Writes are off" } }), { status: 403 })) as unknown as typeof fetch;
    await expect(new HostedTransport("app-store", "k", { fetcher }).call("x", {})).rejects.toThrow(/Writes are off/);
  });
});

describe("createTransport", () => {
  const binDir = mkdtempSync(join(tmpdir(), "spec-bin-"));
  writeFileSync(join(binDir, "appstore"), "#!/bin/sh\n");
  chmodSync(join(binDir, "appstore"), 0o755);

  it("prefers the local CLI, then hosted, then npx", () => {
    expect(createTransport("app-store", { via: "auto", env: { PATH: binDir } }).label).toBe("local appstore CLI");
    expect(createTransport("google-play", { via: "auto", env: { PATH: binDir, APPEEKY_API_KEY: "k" } }).label).toBe("hosted gps-api.appeeky.com");
    expect(createTransport("google-play", { via: "auto", env: { PATH: binDir } }).label).toBe("npx @appeeky/google-play-store-cli");
  });

  it("needs a key for hosted", () => {
    expect(() => createTransport("app-store", { via: "hosted", env: {} })).toThrow(/APPEEKY_API_KEY/);
  });
});
