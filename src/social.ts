import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { AppeekyApiError, type AppeekyApi } from "./appeeky-api.js";
import { SPEC_DIR, SpecError } from "./files.js";

/**
 * Organic social media in the repo, through the accounts connected in Appeeky (APPEEKY_API_KEY,
 * Startup plan or above):
 *
 *   appeeky/social/accounts.yaml        the connected accounts (platform, name, id)
 *   appeeky/social/posts.jsonl          recent posts made through Appeeky, one per line, with each platform's result
 *   appeeky/social/native-posts.jsonl   posts made in the platform's own app, with their results
 *   appeeky/social/comments.jsonl       recent comments on the accounts' posts
 *   appeeky/social/insights.yaml        followers and growth per account
 *   appeeky/social/summary.md           the last 30 days per account and platform, and the posts that did best
 *   appeeky/social/drafts/<name>.yaml   a post: drafted, reviewed in a pull request, then sent
 *
 * Sending creates the post in Appeeky, which publishes it right away, or at `when`.
 */

export const METRICS = ["views", "impressions", "reach", "likes", "comments", "shares", "reposts", "saves", "clicks"] as const;
export type SocialMetric = (typeof METRICS)[number];

export interface SocialAccount {
  id: string;
  platform: string;
  name: string;
  active: boolean;
}

export interface SocialPlatformResult {
  platform: string;
  status: string;
  url?: string;
  publishedAt?: string;
  error?: string;
  /** Uploaded to the creator's TikTok inbox: they finish and post it in the app, so there is no public URL yet. */
  draft?: boolean;
  metrics?: Partial<Record<SocialMetric, number>>;
}

/** A post made in the platform's own app, not through Appeeky. */
export interface NativePost {
  id: string;
  account: string;
  platform: string;
  url?: string;
  text: string;
  mediaType?: string;
  publishedAt?: string;
  metrics?: Partial<Record<SocialMetric | "engagementRate", number>>;
}

export interface SocialComment {
  id: string;
  account: string;
  platform: string;
  postUrl?: string;
  postId?: string;
  platformPostId?: string;
  text: string;
  author?: string;
  own?: boolean;
  reply?: boolean;
  at?: string;
  /** When the account replied to it, through Appeeky. */
  repliedAt?: string;
  hidden?: boolean;
}

export interface AccountInsights {
  account: string;
  platform: string;
  followers?: number;
  growth?: number;
  growthPercentage?: number;
  stats?: Record<string, unknown>;
  history?: Array<{ date: string; followers: number }>;
  updatedAt?: string;
}

/**
 * What `social pull` writes. The native posts, comments and insights are left out (undefined) when
 * the Appeeky API does not have them yet, so the files from an earlier pull are kept.
 */
export interface SocialData {
  accounts: SocialAccount[];
  posts: SocialPost[];
  nativePosts?: NativePost[];
  comments?: SocialComment[];
  insights?: AccountInsights[];
  warnings?: string[];
}

export interface SocialPost {
  id: string;
  status: string;
  text: string;
  createdAt: string;
  scheduledFor?: string;
  platforms: SocialPlatformResult[];
}

export const socialDir = (root: string) => join(root, SPEC_DIR, "social");
export const draftsDir = (root: string) => join(socialDir(root), "drafts");

interface AccountRow {
  id: string;
  platform: string;
  displayName?: string | null;
  platformUserId?: string | null;
  isActive?: boolean | null;
  needsReconnect?: boolean | null;
}

interface PostRow {
  id: string;
  content: string;
  status: string;
  created_at: string;
  scheduled_for: string | null;
  social_media_platform_posts?: Array<{
    platform: string;
    status: string;
    platform_post_url: string | null;
    published_at: string | null;
    error_message: string | null;
    is_draft?: boolean | null;
  }>;
}

interface ExternalPostRow {
  id: string;
  accountId: string;
  platform: string;
  platformPostId?: string | null;
  platformPostUrl?: string | null;
  content?: string | null;
  thumbnailUrl?: string | null;
  mediaType?: string | null;
  publishedAt?: string | null;
  metrics?: Record<string, unknown> | null;
}

interface CommentRow {
  id: string;
  accountId: string;
  platform: string;
  postId?: string | null;
  platformPostId?: string | null;
  postPermalink?: string | null;
  text?: string | null;
  author?: { id?: string | null; username?: string | null; name?: string | null } | null;
  isOwnAccount?: boolean | null;
  isReply?: boolean | null;
  parentCommentId?: string | null;
  commentedAt?: string | null;
  repliedAt?: string | null;
  replyText?: string | null;
  hidden?: boolean | null;
  canReply?: boolean;
  canHide?: boolean;
  canLike?: boolean;
  canDelete?: boolean;
}

interface InsightsRow {
  accountId: string;
  platform: string;
  followers?: number | null;
  growth?: number | null;
  growthPercentage?: number | null;
  stats?: Record<string, unknown> | null;
  history?: Array<{ date: string; followers: number }> | null;
  updatedAt?: string | null;
}

interface AnalyticsItem {
  platform: string;
  analytics: Record<string, unknown>;
}

const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;

export function toAccount(r: AccountRow): SocialAccount {
  return { id: r.id, platform: r.platform, name: r.displayName || r.platformUserId || r.platform, active: r.isActive !== false && !r.needsReconnect };
}

export function toPost(r: PostRow, analytics: AnalyticsItem[] = []): SocialPost {
  return compact({
    id: r.id,
    status: r.status,
    text: r.content,
    createdAt: r.created_at,
    scheduledFor: r.scheduled_for ?? undefined,
    platforms: (r.social_media_platform_posts ?? []).map((p) => {
      const a = analytics.find((x) => x.platform === p.platform)?.analytics ?? {};
      const metrics = Object.fromEntries(METRICS.filter((k) => typeof a[k] === "number" && (a[k] as number) > 0).map((k) => [k, a[k] as number]));
      return compact({
        platform: p.platform,
        status: p.status,
        url: p.platform_post_url ?? undefined,
        publishedAt: p.published_at ?? undefined,
        error: p.error_message ?? undefined,
        draft: p.is_draft ? true : undefined,
        metrics: Object.keys(metrics).length ? metrics : undefined,
      });
    }),
  });
}

const numbers = (m: Record<string, unknown> | null | undefined, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => typeof m?.[k] === "number" && (m[k] as number) > 0).map((k) => [k, m![k] as number]));

export function toNativePost(r: ExternalPostRow, accounts: SocialAccount[]): NativePost {
  const metrics = numbers(r.metrics, [...METRICS, "engagementRate"]);
  return compact({
    id: r.id,
    account: accounts.find((a) => a.id === r.accountId)?.name ?? r.accountId,
    platform: r.platform,
    url: r.platformPostUrl ?? undefined,
    text: r.content ?? "",
    mediaType: r.mediaType ?? undefined,
    publishedAt: r.publishedAt ?? undefined,
    metrics: Object.keys(metrics).length ? metrics : undefined,
  });
}

export function toComment(r: CommentRow, accounts: SocialAccount[]): SocialComment {
  return compact({
    id: r.id,
    account: accounts.find((a) => a.id === r.accountId)?.name ?? r.accountId,
    platform: r.platform,
    postUrl: r.postPermalink ?? undefined,
    postId: r.postId ?? undefined,
    platformPostId: r.platformPostId ?? undefined,
    text: r.text ?? "",
    author: r.author?.username ?? r.author?.name ?? undefined,
    own: r.isOwnAccount ? true : undefined,
    reply: r.isReply ? true : undefined,
    at: r.commentedAt ?? undefined,
    repliedAt: r.repliedAt ?? undefined,
    hidden: r.hidden ? true : undefined,
  });
}

export function toInsights(r: InsightsRow, account: SocialAccount): AccountInsights {
  return compact({
    account: account.name,
    platform: r.platform ?? account.platform,
    followers: r.followers ?? undefined,
    growth: r.growth ?? undefined,
    growthPercentage: r.growthPercentage ?? undefined,
    stats: r.stats && Object.keys(r.stats).length ? r.stats : undefined,
    history: r.history?.length ? r.history : undefined,
    updatedAt: r.updatedAt ?? undefined,
  });
}

/**
 * One call per connected account to an endpoint the deployed Appeeky API may not have yet. A 404
 * (or any other failure) becomes a warning and the pull goes on; a 404 on the first account skips
 * the rest, since the endpoint is missing. `skip` lists error codes that only mean "not for this
 * account" (insights on X or LinkedIn).
 */
async function perAccount<R, T>(accounts: SocialAccount[], what: string, warnings: string[], fetchOne: (a: SocialAccount) => Promise<R>, map: (r: R, a: SocialAccount) => T[], skip: string[] = []): Promise<T[] | undefined> {
  const out: T[] = [];
  let ok = false;
  for (const a of accounts) {
    try {
      out.push(...map(await fetchOne(a), a));
      ok = true;
    } catch (e) {
      if (e instanceof AppeekyApiError && e.code && skip.includes(e.code)) continue;
      if (e instanceof AppeekyApiError && e.status === 404 && !ok) {
        warnings.push(`${what}: not available on this Appeeky API yet, skipped (the file from the last pull is kept)`);
        return undefined;
      }
      warnings.push(`${what} for ${a.platform} ${a.name}: ${(e as Error).message}`);
    }
  }
  return ok || !warnings.some((w) => w.startsWith(`${what} for `)) ? out : undefined;
}

/**
 * Connected accounts and the latest posts made through Appeeky, with analytics for the ones that
 * went out; then, per account, the posts made in the platform's app, recent comments and followers.
 */
export async function fetchSocial(api: AppeekyApi, options: { limit?: number } = {}): Promise<SocialData> {
  const accounts = ((await api.get<AccountRow[]>("/connect/social/accounts")) ?? []).map(toAccount);
  const rows = (await api.get<PostRow[]>("/social/posts", { limit: String(options.limit ?? 100) })) ?? [];
  const posts: SocialPost[] = [];
  for (const row of rows) {
    const published = (row.social_media_platform_posts ?? []).some((p) => p.published_at);
    const analytics = published ? ((await api.get<{ analytics: AnalyticsItem[] }>(`/social/posts/${encodeURIComponent(row.id)}/analytics`).catch(() => null))?.analytics ?? []) : [];
    posts.push(toPost(row, analytics));
  }
  const warnings: string[] = [];
  const active = accounts.filter((a) => a.active);
  const nativePosts = await perAccount(
    active,
    "Native posts",
    warnings,
    (a) => api.get<ExternalPostRow[]>("/social/external-posts", { account_id: a.id, limit: "200" }),
    (rows) => (rows ?? []).map((r) => toNativePost(r, accounts)),
  );
  const comments = await perAccount(
    active,
    "Comments",
    warnings,
    (a) => api.get<CommentRow[]>("/social/comments", { account_id: a.id, limit: "100" }),
    (rows) => (rows ?? []).map((r) => toComment(r, accounts)),
  );
  const insights = await perAccount(
    active,
    "Follower insights",
    warnings,
    (a) => api.get<InsightsRow>(`/connect/social/accounts/${encodeURIComponent(a.id)}/insights`),
    (row, a) => (row ? [toInsights(row, a)] : []),
    ["INSIGHTS_UNAVAILABLE"],
  );
  const unique = <T extends { id: string }>(rows: T[] | undefined) => rows?.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);
  return { accounts, posts, nativePosts: unique(nativePosts), comments: unique(comments), insights, warnings };
}

type Metrics = Partial<Record<SocialMetric | "engagementRate", number>>;
const total = (p: { metrics?: Metrics }, k: SocialMetric) => p.metrics?.[k] ?? 0;
/** The reach of a post on one platform: views when the platform reports them, else impressions or reach. */
const seen = (p: { metrics?: Metrics }) => total(p, "views") || total(p, "impressions") || total(p, "reach");
const score = (p: { metrics?: Metrics }) => seen(p) + total(p, "likes") * 10;
const oneLine = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return `${t.slice(0, max)}${t.length > max ? "…" : ""}`;
};
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function summaryMarkdown(accounts: SocialAccount[], posts: SocialPost[], now = new Date(), more: Pick<SocialData, "nativePosts" | "comments" | "insights"> = {}): string {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const recent = posts.filter((p) => (p.platforms.find((x) => x.publishedAt)?.publishedAt ?? p.createdAt) >= since);
  const native = (more.nativePosts ?? []).filter((p) => (p.publishedAt ?? "") >= since);
  const lines = [`# Social media`, "", `Updated ${now.toISOString().slice(0, 10)}. The last 30 days, from the accounts connected in Appeeky.`, ""];
  lines.push("## Accounts", "");
  if (!accounts.length) lines.push("None connected. Connect them in Appeeky (Social).");
  for (const a of accounts) {
    const i = more.insights?.find((x) => x.account === a.name && x.platform === a.platform);
    const followers = i?.followers !== undefined ? `, ${i.followers} followers${i.growth !== undefined ? ` (${signed(i.growth)}${i.growthPercentage !== undefined ? `, ${signed(Math.round(i.growthPercentage * 10) / 10)}%` : ""})` : ""}` : "";
    lines.push(`- ${a.platform}: ${a.name}${followers}${a.active ? "" : " (needs reconnecting in Appeeky)"}`);
  }
  lines.push("", "## By platform, posts made through Appeeky", "");
  const platforms = [...new Set(recent.flatMap((p) => p.platforms.map((x) => x.platform)))].sort();
  if (!platforms.length) lines.push("No posts in the last 30 days.");
  else {
    lines.push("| Platform | Posts | Seen | Likes | Comments | Shares | Failed |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const platform of platforms) {
      const results = recent.flatMap((p) => p.platforms.filter((x) => x.platform === platform));
      const sum = (f: (x: SocialPlatformResult) => number) => results.reduce((n, x) => n + f(x), 0);
      lines.push(`| ${platform} | ${results.filter((x) => x.publishedAt).length} | ${sum(seen)} | ${sum((x) => total(x, "likes"))} | ${sum((x) => total(x, "comments"))} | ${sum((x) => total(x, "shares") + total(x, "reposts"))} | ${results.filter((x) => x.error).length} |`);
    }
  }
  if (more.nativePosts) {
    lines.push("", "## By account, posts made in the platform's app", "");
    const byAccount = [...new Set(native.map((p) => `${p.platform} ${p.account}`))].sort();
    if (!byAccount.length) lines.push("No posts made in the platform apps in the last 30 days.");
    else {
      lines.push("| Account | Posts | Seen | Likes | Comments | Shares | Saves |", "| --- | --- | --- | --- | --- | --- | --- |");
      for (const key of byAccount) {
        const list = native.filter((p) => `${p.platform} ${p.account}` === key);
        const sum = (f: (x: NativePost) => number) => list.reduce((n, x) => n + f(x), 0);
        lines.push(`| ${key} | ${list.length} | ${sum(seen)} | ${sum((x) => total(x, "likes"))} | ${sum((x) => total(x, "comments"))} | ${sum((x) => total(x, "shares") + total(x, "reposts"))} | ${sum((x) => total(x, "saves"))} |`);
      }
    }
  }
  const best = [
    ...recent.flatMap((p) => p.platforms.filter((x) => x.publishedAt).map((x) => ({ where: x.platform, via: "through Appeeky", text: p.text, at: x.publishedAt!, url: x.url, metrics: x.metrics }))),
    ...native.map((p) => ({ where: `${p.platform} ${p.account}`, via: "in the app", text: p.text, at: p.publishedAt!, url: p.url, metrics: p.metrics })),
  ]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 8);
  if (best.length) {
    lines.push("", "## Did best, all posts", "");
    for (const b of best) lines.push(`- ${b.where}, ${b.at.slice(0, 10)}, ${b.via}: ${seen(b)} seen, ${total(b, "likes")} likes. "${oneLine(b.text, 90)}"${b.url ? ` ${b.url}` : ""}`);
  }
  const inbox = posts.flatMap((p) => p.platforms.filter((x) => x.draft).map((x) => ({ post: p, result: x })));
  if (inbox.length) {
    lines.push("", "## In the TikTok inbox", "", "Uploaded as drafts: the creator finishes and posts them in the TikTok app.", "");
    for (const { post } of inbox) lines.push(`- ${post.createdAt.slice(0, 10)}: "${oneLine(post.text, 80)}"`);
  }
  const heard = (more.comments ?? []).filter((x) => !x.own).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  if (heard.length) {
    lines.push("", "## Latest comments", "", `${heard.length} in comments.jsonl. The latest:`, "");
    for (const x of heard.slice(0, 5)) lines.push(`- ${x.platform} ${x.account}${x.at ? `, ${x.at.slice(0, 10)}` : ""}: "${oneLine(x.text, 120)}"`);
  }
  const waiting = posts.filter((p) => p.status === "scheduled" || p.status === "pending");
  if (waiting.length) {
    lines.push("", "## Waiting to go out", "");
    for (const p of waiting) lines.push(`- ${p.scheduledFor?.slice(0, 16).replace("T", " ") ?? "now"} on ${p.platforms.map((x) => x.platform).join(", ")}: "${oneLine(p.text, 80)}"`);
  }
  return `${lines.join("\n")}\n`;
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

export async function saveSocial(root: string, data: SocialData, now = new Date()): Promise<void> {
  const dir = socialDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "accounts.yaml"), YAML.stringify({ accounts: data.accounts }, { lineWidth: 0 }));
  await writeFile(join(dir, "posts.jsonl"), jsonl(data.posts));
  if (data.nativePosts) await writeFile(join(dir, "native-posts.jsonl"), jsonl(data.nativePosts));
  if (data.comments) await writeFile(join(dir, "comments.jsonl"), jsonl(data.comments));
  if (data.insights) await writeFile(join(dir, "insights.yaml"), YAML.stringify({ accounts: data.insights }, { lineWidth: 0 }));
  // A file the API could not fill this time is kept, and still counts in the summary.
  const kept = async <T>(file: string, rows: T[] | undefined): Promise<T[] | undefined> => {
    if (rows || !existsSync(join(dir, file))) return rows;
    return (await readFile(join(dir, file), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  };
  const insights = data.insights ?? (existsSync(join(dir, "insights.yaml")) ? ((YAML.parse(await readFile(join(dir, "insights.yaml"), "utf8")) as { accounts?: AccountInsights[] } | null)?.accounts ?? undefined) : undefined);
  const more = { nativePosts: await kept("native-posts.jsonl", data.nativePosts), comments: await kept("comments.jsonl", data.comments), insights };
  await writeFile(join(dir, "summary.md"), summaryMarkdown(data.accounts, data.posts, now, more));
}

export async function readAccounts(root: string): Promise<SocialAccount[]> {
  const file = join(socialDir(root), "accounts.yaml");
  if (!existsSync(file)) return [];
  return ((YAML.parse(await readFile(file, "utf8")) as { accounts?: SocialAccount[] } | null)?.accounts ?? []) as SocialAccount[];
}

// ── Drafts ──────────────────────────────────────────────────────────────────

/** TikTok's posting options, in the words a draft uses; each maps to a key of `extra.tiktok` in the API. */
export const PRIVACY = { public: "PUBLIC_TO_EVERYONE", friends: "MUTUAL_FOLLOW_FRIENDS", followers: "FOLLOWER_OF_CREATOR", only_me: "SELF_ONLY" } as const;
export const DISCLOSURE = { none: "none", own_brand: "brand_organic", paid_partnership: "brand_content" } as const;
export const TIKTOK_MAX_PHOTOS = 35;
export const TIKTOK_TITLE_LIMIT = 90;

const tiktokSchema = z
  .object({
    /** Who can see it: public (default), friends, followers or only_me. */
    privacy: z.enum(Object.keys(PRIVACY) as [keyof typeof PRIVACY, ...Array<keyof typeof PRIVACY>]).optional(),
    /** Commercial content: none (default), own_brand (promotes your own app or business) or paid_partnership. */
    disclosure: z.enum(Object.keys(DISCLOSURE) as [keyof typeof DISCLOSURE, ...Array<keyof typeof DISCLOSURE>]).optional(),
    /** Upload to the creator's TikTok inbox instead of posting: they finish and post it in the app. */
    inbox_draft: z.boolean().optional(),
    /** Photo posts: let TikTok add music. */
    auto_music: z.boolean().optional(),
    /** Allow comments (default true). */
    comments: z.boolean().optional(),
    /** Photo posts: the title; the text becomes the description. */
    title: z.string().min(1).optional(),
    /** Photo posts: which image is the cover, from 0. */
    cover_index: z.number().int().min(0).max(TIKTOK_MAX_PHOTOS - 1).optional(),
    /** Video posts: the frame used as the cover, in milliseconds. */
    cover_time_ms: z.number().int().min(0).optional(),
    /** Video posts: an https image used as the cover. */
    cover_image_url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), "must be an https URL")
      .optional(),
  })
  .strict();

export type TikTokOptions = z.infer<typeof tiktokSchema>;

export const YOUTUBE_TITLE_LIMIT = 100;
export const YOUTUBE_VISIBILITY = ["public", "unlisted", "private"] as const;

const youtubeSchema = z
  .object({
    /** The video title; without it, the first line of the text. */
    title: z.string().min(1).optional(),
    /** Who can watch it: public (default), unlisted or private. */
    visibility: z.enum(YOUTUBE_VISIBILITY).optional(),
    /** Made for kids (default false). */
    made_for_kids: z.boolean().optional(),
    /** The video is AI-generated or altered to look real (default false). */
    synthetic_media: z.boolean().optional(),
  })
  .strict();

export type YouTubeOptions = z.infer<typeof youtubeSchema>;

export const draftSchema = z
  .object({
    /**
     * Who it goes to: a platform with one connected account (`twitter`), every account on a
     * platform (`tiktok:all`), a handle (`@sleepysounds`, `tiktok:@sleepysounds`, `u/name`) or an
     * account id from accounts.yaml.
     */
    accounts: z.array(z.string().min(1)).min(1),
    text: z.string().min(1),
    /** ISO time to schedule it; without it, the post goes out when it is sent. */
    when: z.string().optional(),
    /** Public image or video URLs. Instagram, TikTok and Pinterest need one; YouTube needs exactly one video. */
    media: z.array(z.string().url()).optional(),
    /** TikTok's options for the TikTok accounts it goes to. */
    tiktok: tiktokSchema.optional(),
    /** YouTube's options for the YouTube accounts it goes to. */
    youtube: youtubeSchema.optional(),
    /** Why this post, for whoever reviews the pull request. */
    why: z.string().optional(),
    status: z.enum(["draft", "sent"]).default("draft"),
    postId: z.string().optional(),
    sentAt: z.string().optional(),
  })
  .strict();

export type Draft = z.infer<typeof draftSchema>;

/** Character limits per platform, for `check`-style warnings before sending. */
export const TEXT_LIMIT: Record<string, number> = { twitter: 280, x: 280, threads: 500, bluesky: 300, linkedin: 3000, instagram: 2200, tiktok: 2200, facebook: 63206, pinterest: 500, reddit: 40000, youtube: 5000 };
const NEEDS_MEDIA = new Set(["instagram", "tiktok", "pinterest", "youtube"]);

/** Images and videos a post can carry, per platform. TikTok has its own check below. */
export const MEDIA_LIMIT: Record<string, { images: number; videos: number; mix: boolean }> = {
  youtube: { images: 0, videos: 1, mix: false },
  bluesky: { images: 4, videos: 1, mix: false },
  facebook: { images: 10, videos: 1, mix: false },
  threads: { images: 20, videos: 10, mix: true },
};

/** Text length the way the platforms count it: characters, not UTF-16 units. */
export const textLength = (text: string) => [...text].length;

export async function readDrafts(root: string): Promise<Array<Draft & { file: string }>> {
  const dir = draftsDir(root);
  if (!existsSync(dir)) return [];
  const out: Array<Draft & { file: string }> = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort()) {
    const parsed = draftSchema.safeParse(YAML.parse(await readFile(join(dir, f), "utf8")));
    if (!parsed.success) throw new SpecError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), join(dir, f));
    out.push({ ...parsed.data, file: join(dir, f) });
  }
  return out;
}

const platformKey = (p: string) => (p.toLowerCase() === "x" ? "twitter" : p.toLowerCase());

/** The handles an account answers to: its name, and any @handle or u/name inside it ("Appeeky (@appeeky)"). */
export function accountHandles(a: SocialAccount): string[] {
  const name = a.name.toLowerCase();
  return [...new Set([name, ...(name.match(/@[\w.]+|u\/[\w-]+/g) ?? [])])];
}

/** How an account is named in messages: its @handle or u/name when it has one. */
export const accountLabel = (a: SocialAccount) => accountHandles(a).find((h) => h.startsWith("@") || h.startsWith("u/")) ?? a.name;

export interface Resolved {
  accounts: SocialAccount[];
  missing: string[];
  /** Platform names that match more than one connected account, with the handles to pick from. */
  ambiguous: Array<{ ref: string; platform: string; choices: string[] }>;
}

/**
 * The connected accounts a draft goes to. A platform name is only enough when one account is
 * connected on it; with several, the draft names one by handle or says `<platform>:all`.
 */
export function resolveAccounts(draft: Pick<Draft, "accounts">, accounts: SocialAccount[]): Resolved {
  const found: SocialAccount[] = [];
  const missing: string[] = [];
  const ambiguous: Resolved["ambiguous"] = [];
  const active = accounts.filter((a) => a.active);
  for (const ref of draft.accounts) {
    const trimmed = ref.trim();
    const colon = trimmed.indexOf(":");
    const [platform, who] = colon > 0 ? [platformKey(trimmed.slice(0, colon)), trimmed.slice(colon + 1).trim().toLowerCase()] : [undefined, trimmed.toLowerCase()];
    const onPlatform = (a: SocialAccount) => !platform || platformKey(a.platform) === platform;
    let match: SocialAccount[];
    if (platform && who === "all") match = active.filter(onPlatform);
    else if (!platform && active.some((a) => a.id === trimmed)) match = active.filter((a) => a.id === trimmed);
    else if (!platform && !who.startsWith("@") && !who.startsWith("u/") && active.some((a) => platformKey(a.platform) === platformKey(who))) {
      match = active.filter((a) => platformKey(a.platform) === platformKey(who));
      if (match.length > 1) {
        ambiguous.push({ ref, platform: match[0]!.platform, choices: match.map(accountLabel) });
        continue;
      }
    } else {
      match = active.filter((a) => onPlatform(a) && (a.id === trimmed.slice(colon + 1).trim() || accountHandles(a).includes(who)));
      if (match.length > 1) {
        ambiguous.push({ ref, platform: "", choices: match.map((a) => `${a.platform}:${accountLabel(a)}`) });
        continue;
      }
    }
    if (match.length) found.push(...match.filter((a) => !found.includes(a)));
    else missing.push(ref);
  }
  return { accounts: found, missing, ambiguous };
}

const VIDEO = /\.(mp4|mov|m4v|webm)(\?|#|$)/i;
const IMAGE = /\.(jpe?g|png|webp|gif|heic)(\?|#|$)/i;

/** Images and videos in `media:`, by file extension. URLs without one are counted as neither. */
function mediaCounts(media: string[] = []) {
  return { images: media.filter((m) => IMAGE.test(m)).length, videos: media.filter((m) => VIDEO.test(m)).length, total: media.length };
}

function mediaIssues(platform: string, media: string[] | undefined): string[] {
  const limit = MEDIA_LIMIT[platform];
  if (!limit) return [];
  const { images, videos, total } = mediaCounts(media);
  if (platform === "youtube") {
    if (images || total !== 1) return [`youtube: needs exactly one video (media:), and no images`];
    return [];
  }
  const issues: string[] = [];
  if (!limit.mix && images && videos) issues.push(`${platform}: a post is either images or one video, not both (media:)`);
  if (images > limit.images) issues.push(`${platform}: ${images} images, at most ${limit.images}`);
  if (videos > limit.videos) issues.push(`${platform}: ${videos} videos, at most ${limit.videos}`);
  return issues;
}

function youtubeIssues(draft: Draft, toYouTube: boolean): string[] {
  const y = draft.youtube;
  if (!y) return [];
  if (!toYouTube) return ["youtube: options set, but the draft goes to no YouTube account"];
  if (y.title && textLength(y.title) > YOUTUBE_TITLE_LIMIT) return [`youtube: title ${textLength(y.title)}/${YOUTUBE_TITLE_LIMIT} characters`];
  if (!y.title && textLength(draft.text.split("\n")[0]!.trim()) > YOUTUBE_TITLE_LIMIT) return [`youtube: no title, and the first line of the text is over ${YOUTUBE_TITLE_LIMIT} characters; set youtube.title`];
  return [];
}

function tiktokIssues(draft: Draft, toTikTok: boolean): string[] {
  const t = draft.tiktok;
  const media = draft.media ?? [];
  const videos = media.filter((m) => VIDEO.test(m)).length;
  const images = media.filter((m) => IMAGE.test(m)).length;
  const issues: string[] = [];
  if (toTikTok) {
    if (videos && images) issues.push("tiktok: a post is either images or one video, not both (media:)");
    if (images > TIKTOK_MAX_PHOTOS) issues.push(`tiktok: ${images} images, at most ${TIKTOK_MAX_PHOTOS}`);
  }
  if (!t) return issues;
  if (!toTikTok) return [...issues, "tiktok: options set, but the draft goes to no TikTok account"];
  const disclosed = t.disclosure && t.disclosure !== "none";
  if (disclosed && t.privacy === "only_me" && !t.inbox_draft) issues.push(`tiktok: disclosure ${t.disclosure} can't be privacy only_me; make it public, friends or followers, or set inbox_draft: true`);
  if (t.title && t.title.length > TIKTOK_TITLE_LIMIT) issues.push(`tiktok: title ${t.title.length}/${TIKTOK_TITLE_LIMIT} characters`);
  const photo = ["title", "auto_music", "cover_index"].filter((k) => t[k as keyof TikTokOptions] !== undefined);
  const video = ["cover_time_ms", "cover_image_url"].filter((k) => t[k as keyof TikTokOptions] !== undefined);
  if (videos && photo.length) issues.push(`tiktok: ${photo.join(", ")} only apply to photo posts, and media: is a video`);
  if (images && !videos && video.length) issues.push(`tiktok: ${video.join(", ")} only apply to video posts, and media: is images`);
  if (t.cover_index !== undefined && images && t.cover_index >= images) issues.push(`tiktok: cover_index ${t.cover_index} is past the last image (there are ${images}, counted from 0)`);
  return issues;
}

export function draftIssues(draft: Draft, accounts: SocialAccount[], now = new Date()): string[] {
  const issues: string[] = [];
  const { accounts: to, missing, ambiguous } = resolveAccounts(draft, accounts);
  if (missing.length) issues.push(`no connected account for ${missing.join(", ")}`);
  for (const a of ambiguous) {
    issues.push(
      a.platform
        ? `${a.ref} matches ${a.choices.length} ${a.platform} accounts (${a.choices.join(", ")}): name the ones to post on, e.g. ${a.platform}:${a.choices[0]}, or write ${a.platform}:all to post on all ${a.choices.length}`
        : `${a.ref} matches ${a.choices.length} accounts (${a.choices.join(", ")}): add the platform, e.g. ${a.choices[0]}`,
    );
  }
  const platforms = [...new Set(to.map((a) => a.platform.toLowerCase()))];
  for (const p of platforms) {
    const limit = TEXT_LIMIT[p];
    if (limit && textLength(draft.text) > limit) issues.push(`${p}: ${textLength(draft.text)}/${limit} characters`);
    if (NEEDS_MEDIA.has(p) && !draft.media?.length) issues.push(p === "youtube" ? "youtube needs a video (media:)" : `${p} needs an image or video (media:)`);
    else if (draft.media?.length) issues.push(...mediaIssues(p, draft.media));
  }
  issues.push(...tiktokIssues(draft, platforms.includes("tiktok")));
  issues.push(...youtubeIssues(draft, platforms.includes("youtube")));
  if (draft.when && !(new Date(draft.when) > now)) issues.push(`when ${draft.when} is not in the future`);
  return issues;
}

/** A draft's `tiktok:` block as the API's `extra.tiktok`. */
export function tiktokExtra(t: TikTokOptions): Record<string, unknown> {
  return compact({
    privacyLevel: t.privacy ? PRIVACY[t.privacy] : undefined,
    commercialContentType: t.disclosure ? DISCLOSURE[t.disclosure] : undefined,
    draft: t.inbox_draft,
    autoAddMusic: t.auto_music,
    allowComment: t.comments,
    title: t.title,
    photoCoverIndex: t.cover_index,
    videoCoverTimestampMs: t.cover_time_ms,
    videoCoverImageUrl: t.cover_image_url,
  });
}

/** A draft's `youtube:` block as the API's `extra.youtube`. */
export function youtubeExtra(y: YouTubeOptions): Record<string, unknown> {
  return compact({ title: y.title, visibility: y.visibility, madeForKids: y.made_for_kids, containsSyntheticMedia: y.synthetic_media });
}

/** Create the post in Appeeky (it publishes now, or at `when`) and mark the draft sent. */
export async function sendDraft(api: AppeekyApi, draft: Draft & { file: string }, accounts: SocialAccount[], now = new Date()): Promise<string> {
  const { accounts: to, missing, ambiguous } = resolveAccounts(draft, accounts);
  if (missing.length || ambiguous.length || !to.length) throw new Error(draftIssues(draft, accounts, now).join("; ") || "no connected account to send to");
  const on = (platform: string) => to.some((a) => a.platform.toLowerCase() === platform);
  const tiktok = draft.tiktok && on("tiktok") ? tiktokExtra(draft.tiktok) : {};
  const youtube = draft.youtube && on("youtube") ? youtubeExtra(draft.youtube) : {};
  const extra = compact({ tiktok: Object.keys(tiktok).length ? tiktok : undefined, youtube: Object.keys(youtube).length ? youtube : undefined });
  const created = await api.post<{ id: string; status: string }>("/social/posts", {
    content: draft.text,
    account_ids: to.map((a) => a.id),
    ...(draft.when ? { scheduled_for: new Date(draft.when).toISOString() } : {}),
    ...(draft.media?.length ? { media_urls: draft.media } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  });
  const { file, ...rest } = draft;
  await writeFile(file, YAML.stringify({ ...rest, status: "sent", postId: created.id, sentAt: now.toISOString() }, { lineWidth: 0 }));
  return created.id;
}

// ── Comments ────────────────────────────────────────────────────────────────

/** Reply length per platform, as the Appeeky API checks it; other platforms take long replies. */
export const COMMENT_REPLY_MAX: Record<string, number> = {
  bluesky: 300,
  threads: 500,
  twitter: 280,
  instagram: 2200,
  tiktok: 150,
  youtube: 10000,
  reddit: 10000,
  facebook: 8000,
  linkedin: 1250,
};

/** A comment as `social comments` shows it, with what can be done to it. */
export interface CommentItem {
  id: string;
  account: string;
  accountId: string;
  platform: string;
  text: string;
  author?: string;
  postUrl?: string;
  postId?: string;
  at?: string;
  own?: boolean;
  reply?: boolean;
  repliedAt?: string;
  replyText?: string;
  hidden?: boolean;
  canReply: boolean;
  canHide: boolean;
  canLike: boolean;
  canDelete: boolean;
}

export function toCommentItem(r: CommentRow, accounts: SocialAccount[] = []): CommentItem {
  return {
    ...compact({
      id: r.id,
      account: accounts.find((a) => a.id === r.accountId)?.name ?? r.accountId,
      accountId: r.accountId,
      platform: r.platform,
      text: r.text ?? "",
      author: r.author?.username ?? r.author?.name ?? undefined,
      postUrl: r.postPermalink ?? undefined,
      postId: r.postId ?? undefined,
      at: r.commentedAt ?? undefined,
      own: r.isOwnAccount ? true : undefined,
      reply: r.isReply ? true : undefined,
      repliedAt: r.repliedAt ?? undefined,
      replyText: r.replyText ?? undefined,
      hidden: r.hidden ? true : undefined,
    }),
    canReply: r.canReply !== false,
    canHide: r.canHide === true,
    canLike: r.canLike === true,
    canDelete: r.canDelete === true,
  };
}

/** Comments on the connected accounts' posts, newest first. `unanswered`: other people's, not replied to yet. */
export async function listComments(
  api: AppeekyApi,
  options: { unanswered?: boolean; accountId?: string; postId?: string; limit?: number } = {},
  accounts: SocialAccount[] = [],
): Promise<CommentItem[]> {
  const query: Record<string, string> = { status: options.unanswered ? "unanswered" : "all", limit: String(options.limit ?? 50) };
  if (options.accountId) query.account_id = options.accountId;
  if (options.postId) query.post_id = options.postId;
  const rows = (await api.get<CommentRow[]>("/social/comments", query)) ?? [];
  return rows.map((r) => toCommentItem(r, accounts));
}

/** What is wrong with a reply before it is sent, or null. */
export function commentReplyIssue(platform: string | undefined, message: string): string | null {
  if (!message.trim()) return "write a reply first";
  const max = platform ? COMMENT_REPLY_MAX[platformKey(platform)] : undefined;
  const length = textLength(message.trim());
  if (max && length > max) return `${platformKey(platform!)} replies take up to ${max} characters; this one has ${length}`;
  return null;
}

/**
 * The platform a comment is on: from `appeeky/social/comments.jsonl` when the last pull has it,
 * else from the latest comments in Appeeky. Undefined when neither has it (the API still checks).
 */
export async function commentPlatform(api: AppeekyApi, root: string, commentId: string): Promise<string | undefined> {
  const file = join(socialDir(root), "comments.jsonl");
  if (existsSync(file)) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as SocialComment;
      if (row.id === commentId) return row.platform;
    }
  }
  const rows = (await api.get<CommentRow[]>("/social/comments", { status: "all", limit: "200" }).catch(() => null)) ?? [];
  return rows.find((r) => r.id === commentId)?.platform;
}

/**
 * The same reply to the same comment gets the same key, so running the command twice (or a retry
 * after a timeout) posts it once.
 */
export const replyIdempotencyKey = (commentId: string, message: string) =>
  `spec-reply:${commentId}:${createHash("sha256").update(message.trim()).digest("hex").slice(0, 32)}`;

export interface ReplyResult {
  commentId: string;
  replyCommentId: string | null;
  repliedAt: string;
}

/** Reply to a comment from the account it is on. Checks the platform's length first. */
export async function replyToComment(api: AppeekyApi, commentId: string, message: string, platform?: string): Promise<ReplyResult> {
  const issue = commentReplyIssue(platform, message);
  if (issue) throw new Error(`Not sent: ${issue}.`);
  return api.post<ReplyResult>(`/social/comments/${encodeURIComponent(commentId)}/reply`, { message: message.trim() }, { headers: { "Idempotency-Key": replyIdempotencyKey(commentId, message) } });
}

export const hideComment = (api: AppeekyApi, commentId: string, hidden: boolean) =>
  api.post<{ hidden: boolean }>(`/social/comments/${encodeURIComponent(commentId)}/hide`, { hidden });

export const likeComment = (api: AppeekyApi, commentId: string) => api.post<{ liked: true }>(`/social/comments/${encodeURIComponent(commentId)}/like`, {});

export const deleteComment = (api: AppeekyApi, commentId: string) => api.request<{ deleted: true }>("DELETE", `/social/comments/${encodeURIComponent(commentId)}`);
