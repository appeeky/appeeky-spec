import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { AppeekyApi } from "./appeeky-api.js";
import { draftIssues, draftSchema, fetchSocial, readDrafts, resolveAccounts, saveSocial, sendDraft, summaryMarkdown, tiktokExtra, type SocialAccount } from "./social.js";
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
    // The API deployed today has no native posts, comments or insights yet: warn and keep going.
    expect(data.nativePosts).toBeUndefined();
    expect(data.comments).toBeUndefined();
    expect(data.insights).toBeUndefined();
    expect(data.warnings).toHaveLength(3);
    expect(data.warnings![0]).toContain("Native posts: not available on this Appeeky API yet");
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
    expect(existsSync(join(root, "appeeky/social/native-posts.jsonl"))).toBe(false);
  });

  it("writes posts made in the app, comments and followers per account, and ranks hooks across all posts", async () => {
    const { api, calls } = fakeApi({
      "GET /connect/social/accounts": [
        { id: "t1", platform: "tiktok", displayName: "@sleepysounds", isActive: true },
        { id: "t2", platform: "tiktok", displayName: "@rainynights", isActive: true },
        { id: "x1", platform: "twitter", displayName: "Appeeky (@appeeky)", isActive: true },
      ],
      "GET /social/posts": [
        { id: "p1", content: "Made through Appeeky", status: "published", created_at: "2026-11-01T10:00:00Z", scheduled_for: null, social_media_platform_posts: [{ platform: "tiktok", status: "published", platform_post_url: null, published_at: "2026-11-01T10:01:00Z", error_message: null, is_draft: true }] },
      ],
      "GET /social/posts/p1/analytics": { analytics: [] },
      "GET /social/external-posts": [
        { id: "e1", accountId: "t1", platform: "tiktok", platformPostId: "7001", platformPostUrl: "https://tiktok.com/@sleepysounds/video/7001", content: "POV: you fall asleep in 4 minutes\n#sleep", mediaType: "video", publishedAt: "2026-11-03T20:00:00Z", metrics: { likes: 800, comments: 40, shares: 12, saves: 90, views: 52000, impressions: 0, engagementRate: 1.8, updatedAt: "2026-11-07T00:00:00Z" } },
      ],
      "GET /social/comments": [
        { id: "c1", accountId: "t1", platform: "tiktok", postId: null, platformPostId: "7001", postPermalink: "https://tiktok.com/@sleepysounds/video/7001", text: "what app is this?", author: { id: "u", username: "nightowl", name: "N", picture: null }, isOwnAccount: false, isReply: false, parentCommentId: null, commentedAt: "2026-11-04T08:00:00Z" },
      ],
      "GET /connect/social/accounts/t1/insights": { accountId: "t1", platform: "tiktok", followers: 12300, growth: 340, growthPercentage: 2.84, stats: {}, history: [{ date: "2026-11-01", followers: 11960 }], updatedAt: "2026-11-07T00:00:00Z" },
      "GET /connect/social/accounts/t2/insights": { accountId: "t2", platform: "tiktok", followers: 800, growth: 0, history: [] },
    });
    // X has no insights: the API answers 409 INSIGHTS_UNAVAILABLE, which is not a warning.
    const fetcher = (api as unknown as { fetcher: typeof fetch }).fetcher;
    (api as unknown as { fetcher: typeof fetch }).fetcher = (async (input: URL | string, init?: RequestInit) =>
      String(input).includes("/accounts/x1/insights") ? new Response(JSON.stringify({ error: { code: "INSIGHTS_UNAVAILABLE", message: "No insights for X" } }), { status: 409 }) : fetcher(input, init)) as typeof fetch;
    const data = await fetchSocial(api);
    expect(data.warnings).toEqual([]);
    expect(calls.filter((c) => c.path === "/social/external-posts")).toHaveLength(3);
    expect(data.nativePosts![0]).toEqual({ id: "e1", account: "@sleepysounds", platform: "tiktok", url: "https://tiktok.com/@sleepysounds/video/7001", text: "POV: you fall asleep in 4 minutes\n#sleep", mediaType: "video", publishedAt: "2026-11-03T20:00:00Z", metrics: { views: 52000, likes: 800, comments: 40, shares: 12, saves: 90, engagementRate: 1.8 } });
    expect(data.comments![0]).toEqual({ id: "c1", account: "@sleepysounds", platform: "tiktok", postUrl: "https://tiktok.com/@sleepysounds/video/7001", platformPostId: "7001", text: "what app is this?", author: "nightowl", at: "2026-11-04T08:00:00Z" });
    expect(data.insights).toEqual([
      { account: "@sleepysounds", platform: "tiktok", followers: 12300, growth: 340, growthPercentage: 2.84, history: [{ date: "2026-11-01", followers: 11960 }], updatedAt: "2026-11-07T00:00:00Z" },
      { account: "@rainynights", platform: "tiktok", followers: 800, growth: 0 },
    ]);
    expect(data.posts[0]!.platforms[0]!.draft).toBe(true);

    const root = tmp();
    await saveSocial(root, data, new Date("2026-11-08T00:00:00Z"));
    expect(readFileSync(join(root, "appeeky/social/native-posts.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(root, "appeeky/social/comments.jsonl"), "utf8")).toContain("what app is this?");
    expect(YAML.parse(readFileSync(join(root, "appeeky/social/insights.yaml"), "utf8")).accounts).toHaveLength(2);
    const summary = readFileSync(join(root, "appeeky/social/summary.md"), "utf8");
    expect(summary).toContain("- tiktok: @sleepysounds, 12300 followers (+340, +2.8%)");
    expect(summary).toContain("| tiktok @sleepysounds | 1 | 52000 | 800 | 40 | 12 | 90 |");
    expect(summary).toContain('- tiktok @sleepysounds, 2026-11-03, in the app: 52000 seen, 800 likes. "POV: you fall asleep in 4 minutes #sleep"');
    expect(summary).toContain("## In the TikTok inbox");
    expect(summary).toContain('- tiktok @sleepysounds, 2026-11-04: "what app is this?"');

    // A later pull against an API without the new endpoints keeps those files, and the summary still counts them.
    await saveSocial(root, { accounts: data.accounts, posts: data.posts }, new Date("2026-11-08T00:00:00Z"));
    expect(readFileSync(join(root, "appeeky/social/native-posts.jsonl"), "utf8")).toContain("e1");
    expect(readFileSync(join(root, "appeeky/social/summary.md"), "utf8")).toContain("12300 followers");
  });
});

describe("social drafts", () => {
  it("resolves platforms to connected accounts and flags what would fail", () => {
    const draft = { accounts: ["x", "instagram", "tiktok"], text: "a".repeat(300), status: "draft" as const, when: "2026-01-01T00:00:00Z" };
    expect(resolveAccounts(draft, accounts)).toEqual({ accounts: [accounts[0], accounts[1]], missing: ["tiktok"], ambiguous: [] });
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

describe("social drafts for several accounts on one platform", () => {
  const themes: SocialAccount[] = [
    { id: "t1", platform: "tiktok", name: "@sleepysounds", active: true },
    { id: "t2", platform: "tiktok", name: "@rainynights", active: true },
    { id: "t3", platform: "tiktok", name: "@oldtheme", active: false },
    { id: "i1", platform: "instagram", name: "@sleepysounds", active: true },
    { id: "r1", platform: "reddit", name: "u/sleepdev", active: true },
    { id: "x1", platform: "twitter", name: "Appeeky (@appeeky)", active: true },
  ];
  const now = new Date("2026-11-08T00:00:00Z");
  const draft = (accounts: string[], extra: Record<string, unknown> = {}) => draftSchema.parse({ accounts, text: "Rain for sleep", media: ["https://cdn.test/rain.mp4"], ...extra });

  it("refuses a bare platform name with several accounts, and lists the handles", () => {
    expect(resolveAccounts(draft(["tiktok"]), themes)).toEqual({ accounts: [], missing: [], ambiguous: [{ ref: "tiktok", platform: "tiktok", choices: ["@sleepysounds", "@rainynights"] }] });
    expect(draftIssues(draft(["tiktok"]), themes, now)).toEqual(["tiktok matches 2 tiktok accounts (@sleepysounds, @rainynights): name the ones to post on, e.g. tiktok:@sleepysounds, or write tiktok:all to post on all 2"]);
    expect(resolveAccounts(draft(["tiktok:all"]), themes).accounts.map((a) => a.id)).toEqual(["t1", "t2"]);
  });

  it("resolves handles, platform:handle, u/name, ids and a platform with one account", () => {
    const ids = (refs: string[]) => resolveAccounts(draft(refs), themes);
    expect(ids(["tiktok:@rainynights", "TikTok:@SleepySounds"]).accounts.map((a) => a.id)).toEqual(["t2", "t1"]);
    expect(ids(["@rainynights", "u/sleepdev", "i1", "x", "@appeeky"]).accounts.map((a) => a.id)).toEqual(["t2", "r1", "i1", "x1"]);
    expect(ids(["@sleepysounds"]).ambiguous).toEqual([{ ref: "@sleepysounds", platform: "", choices: ["tiktok:@sleepysounds", "instagram:@sleepysounds"] }]);
    expect(ids(["tiktok:@oldtheme", "@nobody"]).missing).toEqual(["tiktok:@oldtheme", "@nobody"]);
  });

  it("maps the tiktok block to extra.tiktok and sends it only to TikTok", async () => {
    const root = tmp();
    mkdirSync(join(root, "appeeky/social/drafts"), { recursive: true });
    const file = join(root, "appeeky/social/drafts/rain.yaml");
    writeFileSync(file, YAML.stringify({ accounts: ["tiktok:@rainynights"], text: "Rain for sleep", media: ["https://cdn.test/rain.mp4"], tiktok: { privacy: "followers", disclosure: "own_brand", inbox_draft: true, comments: false, cover_time_ms: 1500 } }));
    const [d] = await readDrafts(root);
    expect(draftIssues(d!, themes, now)).toEqual([]);
    const { api, calls } = fakeApi({ "POST /social/posts": { id: "p1", status: "publishing" } });
    await sendDraft(api, d!, themes, now);
    expect(calls[0]!.body).toEqual({ content: "Rain for sleep", account_ids: ["t2"], media_urls: ["https://cdn.test/rain.mp4"], extra: { tiktok: { privacyLevel: "FOLLOWER_OF_CREATOR", commercialContentType: "brand_organic", draft: true, allowComment: false, videoCoverTimestampMs: 1500 } } });
    expect(YAML.parse(readFileSync(file, "utf8")).tiktok).toMatchObject({ privacy: "followers" });
    expect(tiktokExtra({ privacy: "only_me", disclosure: "paid_partnership", auto_music: true, title: "Rain", cover_index: 2, cover_image_url: "https://cdn.test/c.png" })).toEqual({
      privacyLevel: "SELF_ONLY",
      commercialContentType: "brand_content",
      autoAddMusic: true,
      title: "Rain",
      photoCoverIndex: 2,
      videoCoverImageUrl: "https://cdn.test/c.png",
    });
  });

  it("refuses an ambiguous draft on send, even without check", async () => {
    const root = tmp();
    const { api, calls } = fakeApi({ "POST /social/posts": { id: "p1", status: "publishing" } });
    await expect(sendDraft(api, { ...draft(["tiktok"]), file: join(root, "x.yaml") }, themes, now)).rejects.toThrow("tiktok:all");
    expect(calls).toHaveLength(0);
  });

  it("checks TikTok's rules before the API does", () => {
    const images = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn.test/${i}.jpg`);
    const issues = (extra: Record<string, unknown>, refs = ["tiktok:@sleepysounds"]) => draftIssues(draft(refs, extra), themes, now);
    expect(issues({ tiktok: { disclosure: "own_brand", privacy: "only_me" } })).toEqual(["tiktok: disclosure own_brand can't be privacy only_me; make it public, friends or followers, or set inbox_draft: true"]);
    expect(issues({ tiktok: { disclosure: "own_brand", privacy: "only_me", inbox_draft: true } })).toEqual([]);
    expect(issues({ media: images(36) })).toEqual(["tiktok: 36 images, at most 35"]);
    expect(issues({ media: ["https://cdn.test/a.jpg", "https://cdn.test/b.mp4"] })).toEqual(["tiktok: a post is either images or one video, not both (media:)"]);
    expect(issues({ media: images(3), tiktok: { title: "t".repeat(91), cover_index: 3, cover_time_ms: 10 } })).toEqual([
      "tiktok: title 91/90 characters",
      "tiktok: cover_time_ms only apply to video posts, and media: is images",
      "tiktok: cover_index 3 is past the last image (there are 3, counted from 0)",
    ]);
    expect(issues({ tiktok: { auto_music: true } })).toEqual(["tiktok: auto_music only apply to photo posts, and media: is a video"]);
    expect(issues({ tiktok: { privacy: "public" } }, ["instagram"])).toEqual(["tiktok: options set, but the draft goes to no TikTok account"]);
    expect(draftSchema.safeParse({ accounts: ["tiktok"], text: "x", tiktok: { privacy: "everyone" } }).success).toBe(false);
    expect(draftSchema.safeParse({ accounts: ["tiktok"], text: "x", tiktok: { music: true } }).success).toBe(false);
    expect(draftSchema.safeParse({ accounts: ["tiktok"], text: "x", tiktok: { cover_image_url: "http://cdn.test/c.png" } }).success).toBe(false);
    expect(draftSchema.safeParse({ accounts: ["tiktok"], text: "x", tiktok: { cover_index: 35 } }).success).toBe(false);
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
    mkdirSync(join(root, "appeeky/reviews/replies"), { recursive: true });
    writeFileSync(join(root, "appeeky/reviews/replies/google-play-r1.yaml"), YAML.stringify({ id: "r1", store: "google-play", review: "Stops after an hour", text: "x".repeat(400) }));
    writeFileSync(join(root, "appeeky/reviews/replies/app-store-r2.yaml"), YAML.stringify({ id: "r2", store: "app-store", text: "Thanks", status: "sent" }));
    const md = await outboxReport(root, new Date("2026-11-08T00:00:00Z"));
    expect(md).toContain("**1 review reply goes out on merge**");
    expect(md).toContain("| appeeky/reviews/replies/google-play-r1.yaml | google-play | Stops after an hour |");
    expect(md).toContain("- ⚠️ appeeky/reviews/replies/google-play-r1.yaml: too long, 400/350 characters");
    expect(md).toContain("**1 post goes out on merge**");
    expect(md).toContain("| appeeky/social/drafts/fan.yaml | instagram | on merge | Fan \\| sounds |");
    expect(md).toContain("- ⚠️ appeeky/social/drafts/fan.yaml: instagram needs an image or video (media:)");
    expect(md).toContain("| appeeky/ugc/briefs/hook.yaml | Maya | 8s 9:16 | Out in ten minutes. |");
    expect(await outboxReport(tmp())).toBe("");
  });
});
