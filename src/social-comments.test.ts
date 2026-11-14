import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";
import { commentReplyIssue, draftIssues, draftSchema, replyIdempotencyKey, sendDraft, youtubeExtra, type SocialAccount } from "./social.js";
import { AppeekyApi } from "./appeeky-api.js";

const accounts: SocialAccount[] = [
  { id: "y1", platform: "youtube", name: "@sleepysounds", active: true },
  { id: "th1", platform: "threads", name: "@sleepysounds", active: true },
  { id: "b1", platform: "bluesky", name: "@sleepysounds.bsky.social", active: true },
  { id: "f1", platform: "facebook", name: "Sleep Sounds", active: true },
  { id: "x1", platform: "twitter", name: "@sleepysounds", active: true },
];
const now = new Date("2026-11-13T00:00:00Z");
const draft = (refs: string[], extra: Record<string, unknown> = {}) => draftSchema.parse({ accounts: refs, text: "Rain for sleep", ...extra });
const images = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn.test/${i}.jpg`);

describe("social drafts for YouTube, Threads, Bluesky and Facebook", () => {
  const issues = (refs: string[], extra: Record<string, unknown> = {}) => draftIssues(draft(refs, extra), accounts, now);

  it("takes text-only posts on Threads, Bluesky and Facebook, within their limits", () => {
    expect(issues(["threads", "bluesky", "facebook"])).toEqual([]);
    expect(issues(["threads"], { text: "a".repeat(501) })).toEqual(["threads: 501/500 characters"]);
    expect(issues(["bluesky"], { text: "a".repeat(301) })).toEqual(["bluesky: 301/300 characters"]);
    // Counted in characters, the way the platforms count them.
    expect(issues(["bluesky"], { text: "🌧".repeat(300) })).toEqual([]);
  });

  it("checks images and video per platform", () => {
    expect(issues(["bluesky"], { media: images(4) })).toEqual([]);
    expect(issues(["bluesky"], { media: images(5) })).toEqual(["bluesky: 5 images, at most 4"]);
    expect(issues(["bluesky"], { media: ["https://cdn.test/a.jpg", "https://cdn.test/b.mp4"] })).toEqual(["bluesky: a post is either images or one video, not both (media:)"]);
    expect(issues(["facebook"], { media: images(11) })).toEqual(["facebook: 11 images, at most 10"]);
    expect(issues(["facebook"], { media: ["https://cdn.test/a.mp4", "https://cdn.test/b.mp4"] })).toEqual(["facebook: 2 videos, at most 1"]);
    expect(issues(["threads"], { media: ["https://cdn.test/a.jpg", "https://cdn.test/b.mp4"] })).toEqual([]);
  });

  it("needs exactly one video for YouTube, and checks its options", () => {
    expect(issues(["youtube"])).toEqual(["youtube needs a video (media:)"]);
    expect(issues(["youtube"], { media: ["https://cdn.test/a.jpg"] })).toEqual(["youtube: needs exactly one video (media:), and no images"]);
    expect(issues(["youtube"], { media: ["https://cdn.test/a.mp4", "https://cdn.test/b.mp4"] })).toEqual(["youtube: needs exactly one video (media:), and no images"]);
    expect(issues(["youtube"], { media: ["https://cdn.test/a.mp4"], youtube: { title: "Rain", visibility: "unlisted" } })).toEqual([]);
    expect(issues(["youtube"], { media: ["https://cdn.test/a.mp4"], youtube: { title: "t".repeat(101) } })).toEqual(["youtube: title 101/100 characters"]);
    expect(issues(["youtube"], { media: ["https://cdn.test/a.mp4"], text: "t".repeat(120), youtube: { visibility: "public" } })).toEqual([
      "youtube: no title, and the first line of the text is over 100 characters; set youtube.title",
    ]);
    expect(issues(["threads"], { youtube: { visibility: "private" } })).toEqual(["youtube: options set, but the draft goes to no YouTube account"]);
    expect(draftSchema.safeParse({ accounts: ["youtube"], text: "x", youtube: { visibility: "friends" } }).success).toBe(false);
    expect(draftSchema.safeParse({ accounts: ["youtube"], text: "x", youtube: { kids: true } }).success).toBe(false);
  });

  it("sends the youtube block as extra.youtube, only with a YouTube account", async () => {
    expect(youtubeExtra({ title: "Rain", visibility: "unlisted", made_for_kids: false, synthetic_media: true })).toEqual({ title: "Rain", visibility: "unlisted", madeForKids: false, containsSyntheticMedia: true });
    const root = mkdtempSync(join(tmpdir(), "spec-yt-"));
    const bodies: unknown[] = [];
    const fetcher = (async (_: URL | string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: { id: "p1", status: "publishing" } }), { status: 200 });
    }) as typeof fetch;
    const api = new AppeekyApi("k", { baseUrl: "https://api.test/v1", fetcher });
    const d = draft(["youtube", "threads"], { media: ["https://cdn.test/a.mp4"], youtube: { title: "Rain", synthetic_media: true } });
    await sendDraft(api, { ...d, file: join(root, "d.yaml") }, accounts, now);
    expect(bodies[0]).toEqual({ content: "Rain for sleep", account_ids: ["y1", "th1"], media_urls: ["https://cdn.test/a.mp4"], extra: { youtube: { title: "Rain", containsSyntheticMedia: true } } });
    await sendDraft(api, { ...draft(["threads"], { youtube: { title: "Rain" } }), file: join(root, "e.yaml") }, accounts, now);
    expect(bodies[1]).not.toHaveProperty("extra");
  });
});

describe("comment replies", () => {
  it("checks the platform's reply limit", () => {
    expect(commentReplyIssue("bluesky", "a".repeat(300))).toBeNull();
    expect(commentReplyIssue("bluesky", "a".repeat(301))).toBe("bluesky replies take up to 300 characters; this one has 301");
    expect(commentReplyIssue("x", "a".repeat(281))).toBe("twitter replies take up to 280 characters; this one has 281");
    expect(commentReplyIssue(undefined, "a".repeat(5000))).toBeNull();
    expect(commentReplyIssue("tiktok", "  ")).toBe("write a reply first");
  });

  it("gives the same reply to the same comment the same idempotency key", () => {
    expect(replyIdempotencyKey("c1", "Thanks!")).toBe(replyIdempotencyKey("c1", " Thanks! "));
    expect(replyIdempotencyKey("c1", "Thanks!")).not.toBe(replyIdempotencyKey("c2", "Thanks!"));
    expect(replyIdempotencyKey("c1", "Thanks!")).not.toBe(replyIdempotencyKey("c1", "Thank you!"));
  });
});

type Call = { method: string; path: string; query: Record<string, string>; body?: unknown; headers: Record<string, string> };

describe("social comment commands", () => {
  let dir: string;
  let out: string[];
  let calls: Call[];
  let routes: Record<string, unknown>;
  const oldEnv = { ...process.env };
  const tty = process.stdin.isTTY;

  const cli = async (...args: string[]) => {
    out = [];
    process.exitCode = undefined;
    await run(["node", "appeeky-spec", "--cwd", dir, "--json", ...args]);
    const text = out.join("");
    return { json: text ? JSON.parse(text) : undefined, code: process.exitCode ?? 0 };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-comments-"));
    process.env.APPEEKY_API_KEY = "k";
    process.env.APPEEKY_API_URL = "https://api.test/v1";
    calls = [];
    routes = {};
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/v1/, "");
      const method = init?.method ?? "GET";
      calls.push({ method, path, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      const key = `${method} ${path}`;
      if (!(key in routes)) return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), { status: 404 });
      return new Response(JSON.stringify({ data: routes[key] }), { status: 200 });
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...oldEnv };
    process.exitCode = undefined;
    Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  });

  const comment = { id: "c1", accountId: "b1", platform: "bluesky", text: "Does it work offline?", author: { username: "sam" }, commentedAt: "2026-11-12T10:00:00Z", repliedAt: null, isOwnAccount: false, canReply: true, canHide: false, canLike: true, canDelete: false };

  it("lists unanswered comments for an account named by handle", async () => {
    mkdirSync(join(dir, "appeeky/social"), { recursive: true });
    writeFileSync(join(dir, "appeeky/social/accounts.yaml"), "accounts:\n  - { id: b1, platform: bluesky, name: '@sleepysounds.bsky.social', active: true }\n");
    routes["GET /social/comments"] = [comment];
    const { json } = await cli("social", "comments", "--unanswered", "--account", "bluesky", "--limit", "10");
    expect(calls[0]!.query).toEqual({ status: "unanswered", limit: "10", account_id: "b1" });
    expect(json.comments).toEqual([{ id: "c1", account: "@sleepysounds.bsky.social", accountId: "b1", platform: "bluesky", text: "Does it work offline?", author: "sam", at: "2026-11-12T10:00:00Z", canReply: true, canHide: false, canLike: true, canDelete: false }]);
  });

  it("replies with an idempotency key, after checking the platform's limit", async () => {
    routes["GET /social/comments"] = [comment];
    routes["POST /social/comments/c1/reply"] = { commentId: "c1", replyCommentId: "r1", repliedAt: "2026-11-13T00:00:00Z" };
    const { json, code } = await cli("social", "reply", "c1", "Yes, all sounds work offline.");
    expect(code).toBe(0);
    expect(json).toEqual({ commentId: "c1", replyCommentId: "r1", repliedAt: "2026-11-13T00:00:00Z" });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ message: "Yes, all sounds work offline." });
    expect(post.headers["Idempotency-Key"]).toBe(replyIdempotencyKey("c1", "Yes, all sounds work offline."));
  });

  it("refuses a reply over the limit without calling the API to send it", async () => {
    mkdirSync(join(dir, "appeeky/social"), { recursive: true });
    writeFileSync(join(dir, "appeeky/social/comments.jsonl"), `${JSON.stringify({ id: "c1", account: "x", platform: "bluesky", text: "hi" })}\n`);
    const { json, code } = await cli("social", "reply", "c1", "a".repeat(301));
    expect(code).toBe(1);
    expect(json.error).toContain("bluesky replies take up to 300 characters");
    expect(calls).toHaveLength(0);
  });

  it("refuses to delete a comment without --yes when not in a terminal", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    routes["DELETE /social/comments/c1"] = { deleted: true };
    const refused = await cli("social", "delete-comment", "c1");
    expect(refused.code).toBe(1);
    expect(refused.json.error).toContain("pass --yes");
    expect(calls).toHaveLength(0);

    const done = await cli("social", "delete-comment", "c1", "--yes");
    expect(done.json).toEqual({ commentId: "c1", deleted: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /social/comments/c1"]);
  });

  it("hides, unhides and likes", async () => {
    routes["POST /social/comments/c1/hide"] = { hidden: false };
    routes["POST /social/comments/c1/like"] = { liked: true };
    await cli("social", "hide", "c1", "--unhide");
    await cli("social", "like", "c1");
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ["/social/comments/c1/hide", { hidden: false }],
      ["/social/comments/c1/like", {}],
    ]);
  });
});
