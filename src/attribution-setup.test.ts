import { describe, expect, it } from "vitest";
import { attributionBlock, initSelfHosted, nextSteps } from "./attribution-setup.js";
import { specFileSchema } from "./schema.js";

const spec = specFileSchema.parse({ version: 1, app: { name: "Sleep Sounds" }, stores: { appStore: { appId: "123" }, googlePlay: { packageName: "com.x" } } });

describe("attribution init, self-hosted", () => {
  it("finds the store's app on the server or creates it", async () => {
    const created: unknown[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        created.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: "app_and", name: "Sleep Sounds", platform: "google", storeAppId: "com.x", publishableKey: "apk_and" }), { status: 201 });
      }
      expect(url).toBe("https://a.dev/v1/apps");
      return new Response(JSON.stringify({ apps: [{ id: "app_ios", name: "Sleep", platform: "apple", storeAppId: "123", publishableKey: "apk_ios" }] }));
    }) as unknown as typeof fetch;
    const apps = await initSelfHosted(spec, "https://a.dev/", "t", fetcher);
    expect(apps.map((a) => [a.store, a.id, a.created])).toEqual([
      ["app-store", "app_ios", false],
      ["google-play", "app_and", true],
    ]);
    expect(created).toEqual([{ name: "Sleep Sounds", platform: "google", storeAppId: "com.x" }]);
    expect(attributionBlock("self", apps, "https://a.dev/")).toEqual({ via: "self", url: "https://a.dev", app: { "app-store": "app_ios", "google-play": "app_and" } });
    expect(nextSteps("self", apps, "https://a.dev")).toContain('  Appeeky.init({ key: Platform.OS === "ios" ? "apk_ios" : "apk_and", endpoint: "https://a.dev/v1/ingest" });');
  });

  it("writes one id when both stores share it (hosted uses each store's id)", () => {
    const one = [{ store: "app-store" as const, id: "123", publishableKey: "k", endpoint: "e", created: true }];
    expect(attributionBlock("hosted", one)).toEqual({ via: "hosted", app: "123" });
  });
});
