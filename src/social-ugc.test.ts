import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { AppeekyApi } from "./appeeky-api.js";
import { draftIssues, fetchSocial, readDrafts, resolveAccounts, saveSocial, sendDraft, summaryMarkdown, type SocialAccount } from "./social.js";
import { outboxReport } from "./report.js";
import { fetchUgc, findPersona, generateBrief, quoteBrief, readBriefs } from "./ugc.js";

type Call = { method: string; path: string; body?: unknown };

/** A fake Appeeky API: answers by method and path, and records every call. */
function fakeApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), { status: 404 });
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200 });
  }) as typeof fetch;
  return { api: new AppeekyApi("k", { baseUrl: "https://api.test/v1", fetcher }), calls };
}

const tmp = () => {
  const root = mkdtempSync(join(tmpdir(), "spec-social-"));
  mkdirSync(join(root, "appeeky"), { recursive: true });
  return root;
};

const accounts: SocialAccount[] = [
  { id: "a1", platform: "twitter", name: "Appeeky (@appeeky)", active: true },
  { id: "a2", platform: "instagram", name: "@appeeky", active: true },
  { id: "a3", platform: "tiktok", name: "appeeky", active: false },
];

describe("social pull", () => {
  it("keeps the accounts and posts, with analytics only for published posts", async () => {
    const { api, calls } = fakeApi({
      "GET /connect/social/accounts": [{ id: "a1", platform: "twitter", displayName: "Appeeky (@appeeky)", isActive: true }, { id: "a3", platform: "tiktok", displayName: "appeeky", isActive: true, needsReconnect: true }],
      "GET /social/posts": [
        { id: "p1", content: "New: fan sounds", status: "published", created_at: "2026-11-01T10:00:00Z", scheduled_for: null, social_media_platform_posts: [{ platform: "twitter", status: "published", platform_post_url: "https://x.com/1", published_at: "2026-11-01T10:01:00Z", error_message: null }] },
        { id: "p2", content: "Soon", status: "scheduled", created_at: "2026-11-05T10:00:00Z", scheduled_for: "2026-11-20T16:00:00Z", social_media_platform_posts: [{ platform: "twitter", status: "pending", platform_post_url: null, published_at: null, error_message: null }] },
      ],
      "GET /social/posts/p1/analytics": { analytics: [{ platform: "twitter", analytics: { likes: 12, views: 900, comments: 0 } }] },
    });
    const data = await fetchSocial(api);
    expect(calls.filter((c) => c.path.endsWith("/analytics")).map((c) => c.path)).toEqual(["/social/posts/p1/analytics"]);
    expect(data.accounts).toEqual([
      { id: "a1", platform: "twitter", name: "Appeeky (@appeeky)", active: true },
      { id: "a3", platform: "tiktok", name: "appeeky", active: false },
    ]);
    expect(data.posts[0]!.platforms[0]).toEqual({ platform: "twitter", status: "published", url: "https://x.com/1", publishedAt: "2026-11-01T10:01:00Z", metrics: { views: 900, likes: 12 } });

    const summary = summaryMarkdown(data.accounts, data.posts, new Date("2026-11-08T00:00:00Z"));
    expect(summary).toContain("| twitter | 1 | 900 | 12 | 0 | 0 | 0 |");
    expect(summary).toContain("tiktok: appeeky (needs reconnecting in Appeeky)");
    expect(summary).toContain("## Waiting to go out");

    const root = tmp();
    await saveSocial(root, data);
    expect(readFileSync(join(root, "appeeky/social/posts.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("social drafts", () => {
  it("resolves platforms to connected accounts and flags what would fail", () => {
    const draft = { accounts: ["x", "instagram", "tiktok"], text: "a".repeat(300), status: "draft" as const, when: "2026-01-01T00:00:00Z" };
    expect(resolveAccounts(draft, accounts)).toEqual({ accounts: [accounts[0], accounts[1]], missing: ["tiktok"] });
    expect(draftIssues(draft, accounts, new Date("2026-11-08T00:00:00Z"))).toEqual([
      "no connected account for tiktok",
      "twitter: 300/280 characters",
      "instagram needs an image or video (media:)",
      "when 2026-01-01T00:00:00Z is not in the future",
    ]);
  });

  it("sends a draft as one post to its accounts and marks it sent", async () => {
    const root = tmp();
    mkdirSync(join(root, "appeeky/social/drafts"), { recursive: true });
    writeFileSync(join(root, "appeeky/social/drafts/launch.yaml"), YAML.stringify({ accounts: ["twitter"], text: "Fan sounds are here.", when: "2026-12-01T16:00:00Z" }));
    const [draft] = await readDrafts(root);
    const { api, calls } = fakeApi({ "POST /social/posts": { id: "p9", status: "scheduled" } });
    expect(await sendDraft(api, draft!, accounts, new Date("2026-11-08T00:00:00Z"))).toBe("p9");
    expect(calls[0]).toEqual({ method: "POST", path: "/social/posts", body: { content: "Fan sounds are here.", account_ids: ["a1"], scheduled_for: "2026-12-01T16:00:00.000Z" } });
    const saved = YAML.parse(readFileSync(join(root, "appeeky/social/drafts/launch.yaml"), "utf8"));
    expect(saved).toMatchObject({ status: "sent", postId: "p9", sentAt: "2026-11-08T00:00:00.000Z" });
  });
});

describe("ugc", () => {
  it("pulls personas with whether they can make clips, and clips without expiring URLs", async () => {
    const { api } = fakeApi({
      "GET /ugc/personas": { personas: [{ id: "u1", name: "Maya", status: "active", referenceAssetIds: ["img"], lane: "sleepy parent" }, { id: "u2", name: "Eren", referenceAssetIds: [] }] },
      "GET /ugc/clips": { clips: [{ id: "c1", personaId: "u1", status: "ready", script: "Out in ten minutes.", createdAt: "2026-11-01T00:00:00Z", videoUrl: "https://signed", scheduledFor: null }] },
    });
    const { personas, clips } = await fetchUgc(api);
    expect(personas.map((p) => [p.name, p.ready])).toEqual([["Maya", true], ["Eren", false]]);
    expect(clips).toEqual([{ id: "c1", persona: "Maya", status: "ready", script: "Out in ten minutes.", createdAt: "2026-11-01T00:00:00Z" }]);
  });

  it("quotes a brief without making it, then generates and records the clip", async () => {
    const root = tmp();
    mkdirSync(join(root, "appeeky/ugc/briefs"), { recursive: true });
    writeFileSync(join(root, "appeeky/ugc/briefs/hook.yaml"), YAML.stringify({ persona: "maya", script: "Out in ten minutes.", durationSec: 8 }));
    const [brief] = await readBriefs(root);
    const persona = findPersona(brief!, [{ id: "u1", name: "Maya", ready: true }])!;
    const { api, calls } = fakeApi({ "POST /ugc/personas/u1/clips": { credits: 40, available: 100, affordable: true, clip: { id: "c7" } } });
    expect(await quoteBrief(api, brief!, persona)).toMatchObject({ credits: 40, affordable: true });
    expect(calls[0]!.body).toEqual({ script: "Out in ten minutes.", durationSec: 8, dryRun: true });
    expect(await generateBrief(api, brief!, persona, new Date("2026-11-08T00:00:00Z"))).toEqual({ clipId: "c7", credits: 40 });
    expect(calls[1]!.body).toEqual({ script: "Out in ten minutes.", durationSec: 8 });
    expect(YAML.parse(readFileSync(join(root, "appeeky/ugc/briefs/hook.yaml"), "utf8"))).toMatchObject({ status: "generating", clipId: "c7", credits: 40 });
  });
});

describe("report", () => {
  it("lists the posts and clips a merge sends out, with what would fail", async () => {
    const root = tmp();
    mkdirSync(join(root, "appeeky/social/drafts"), { recursive: true });
    mkdirSync(join(root, "appeeky/ugc/briefs"), { recursive: true });
    writeFileSync(join(root, "appeeky/social/accounts.yaml"), YAML.stringify({ accounts }));
    writeFileSync(join(root, "appeeky/social/drafts/fan.yaml"), YAML.stringify({ accounts: ["instagram"], text: "Fan | sounds" }));
    writeFileSync(join(root, "appeeky/social/drafts/old.yaml"), YAML.stringify({ accounts: ["twitter"], text: "Sent", status: "sent" }));
    writeFileSync(join(root, "appeeky/ugc/briefs/hook.yaml"), YAML.stringify({ persona: "Maya", script: "Out in ten minutes." }));
    const md = await outboxReport(root, new Date("2026-11-08T00:00:00Z"));
    expect(md).toContain("**1 post goes out on merge**");
    expect(md).toContain("| appeeky/social/drafts/fan.yaml | instagram | on merge | Fan \\| sounds |");
    expect(md).toContain("- ⚠️ appeeky/social/drafts/fan.yaml: instagram needs an image or video (media:)");
    expect(md).toContain("| appeeky/ugc/briefs/hook.yaml | Maya | 8s 9:16 | Out in ten minutes. |");
    expect(await outboxReport(tmp())).toBe("");
  });
});
