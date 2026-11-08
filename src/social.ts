import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppeekyApi } from "./appeeky-api.js";
import { SPEC_DIR, SpecError } from "./files.js";

/**
 * Organic social media in the repo, through the accounts connected in Appeeky (APPEEKY_API_KEY,
 * Startup plan or above):
 *
 *   appeeky/social/accounts.yaml        the connected accounts (platform, name, id)
 *   appeeky/social/posts.jsonl          recent posts, one per line, with each platform's result
 *   appeeky/social/summary.md           the last 30 days per platform, and the posts that did best
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
  metrics?: Partial<Record<SocialMetric, number>>;
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
  }>;
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
        metrics: Object.keys(metrics).length ? metrics : undefined,
      });
    }),
  });
}

/** Connected accounts and the latest posts, with analytics for the ones that went out. */
export async function fetchSocial(api: AppeekyApi, options: { limit?: number } = {}): Promise<{ accounts: SocialAccount[]; posts: SocialPost[] }> {
  const accounts = ((await api.get<AccountRow[]>("/connect/social/accounts")) ?? []).map(toAccount);
  const rows = (await api.get<PostRow[]>("/social/posts", { limit: String(options.limit ?? 100) })) ?? [];
  const posts: SocialPost[] = [];
  for (const row of rows) {
    const published = (row.social_media_platform_posts ?? []).some((p) => p.published_at);
    const analytics = published ? ((await api.get<{ analytics: AnalyticsItem[] }>(`/social/posts/${encodeURIComponent(row.id)}/analytics`).catch(() => null))?.analytics ?? []) : [];
    posts.push(toPost(row, analytics));
  }
  return { accounts, posts };
}

const total = (p: SocialPlatformResult, k: SocialMetric) => p.metrics?.[k] ?? 0;
/** The reach of a post on one platform: views when the platform reports them, else impressions or reach. */
const seen = (p: SocialPlatformResult) => total(p, "views") || total(p, "impressions") || total(p, "reach");

export function summaryMarkdown(accounts: SocialAccount[], posts: SocialPost[], now = new Date()): string {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const recent = posts.filter((p) => (p.platforms.find((x) => x.publishedAt)?.publishedAt ?? p.createdAt) >= since);
  const lines = [`# Social media`, "", `Updated ${now.toISOString().slice(0, 10)}. The last 30 days, from the accounts connected in Appeeky.`, ""];
  lines.push("## Accounts", "");
  if (!accounts.length) lines.push("None connected. Connect them in Appeeky (Social).");
  for (const a of accounts) lines.push(`- ${a.platform}: ${a.name}${a.active ? "" : " (needs reconnecting in Appeeky)"}`);
  lines.push("", "## By platform", "");
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
  const best = recent
    .flatMap((p) => p.platforms.filter((x) => x.publishedAt).map((x) => ({ post: p, result: x })))
    .sort((a, b) => seen(b.result) + total(b.result, "likes") * 10 - (seen(a.result) + total(a.result, "likes") * 10))
    .slice(0, 5);
  if (best.length) {
    lines.push("", "## Did best", "");
    for (const { post, result } of best) {
      const text = post.text.replace(/\s+/g, " ").slice(0, 90);
      lines.push(`- ${result.platform}, ${result.publishedAt!.slice(0, 10)}: ${seen(result)} seen, ${total(result, "likes")} likes. "${text}${post.text.length > 90 ? "…" : ""}"${result.url ? ` ${result.url}` : ""}`);
    }
  }
  const waiting = posts.filter((p) => p.status === "scheduled" || p.status === "pending");
  if (waiting.length) {
    lines.push("", "## Waiting to go out", "");
    for (const p of waiting) lines.push(`- ${p.scheduledFor?.slice(0, 16).replace("T", " ") ?? "now"} on ${p.platforms.map((x) => x.platform).join(", ")}: "${p.text.replace(/\s+/g, " ").slice(0, 80)}"`);
  }
  return `${lines.join("\n")}\n`;
}

export async function saveSocial(root: string, data: { accounts: SocialAccount[]; posts: SocialPost[] }, now = new Date()): Promise<void> {
  await mkdir(socialDir(root), { recursive: true });
  await writeFile(join(socialDir(root), "accounts.yaml"), YAML.stringify({ accounts: data.accounts }, { lineWidth: 0 }));
  await writeFile(join(socialDir(root), "posts.jsonl"), data.posts.map((p) => JSON.stringify(p)).join("\n") + (data.posts.length ? "\n" : ""));
  await writeFile(join(socialDir(root), "summary.md"), summaryMarkdown(data.accounts, data.posts, now));
}

export async function readAccounts(root: string): Promise<SocialAccount[]> {
  const file = join(socialDir(root), "accounts.yaml");
  if (!existsSync(file)) return [];
  return ((YAML.parse(await readFile(file, "utf8")) as { accounts?: SocialAccount[] } | null)?.accounts ?? []) as SocialAccount[];
}

// ── Drafts ──────────────────────────────────────────────────────────────────

export const draftSchema = z
  .object({
    /** Platforms (twitter, instagram, tiktok, …) or account ids from accounts.yaml. */
    accounts: z.array(z.string().min(1)).min(1),
    text: z.string().min(1),
    /** ISO time to schedule it; without it, the post goes out when it is sent. */
    when: z.string().optional(),
    /** Public image or video URLs. Instagram, TikTok and Pinterest need one. */
    media: z.array(z.string().url()).optional(),
    /** Why this post, for whoever reviews the pull request. */
    why: z.string().optional(),
    status: z.enum(["draft", "sent"]).default("draft"),
    postId: z.string().optional(),
    sentAt: z.string().optional(),
  })
  .strict();

export type Draft = z.infer<typeof draftSchema>;

/** Character limits per platform, for `check`-style warnings before sending. */
export const TEXT_LIMIT: Record<string, number> = { twitter: 280, x: 280, threads: 500, bluesky: 300, linkedin: 3000, instagram: 2200, tiktok: 2200, facebook: 63206, pinterest: 500, reddit: 40000 };
const NEEDS_MEDIA = new Set(["instagram", "tiktok", "pinterest"]);

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

/** The connected accounts a draft goes to: platform names match every active account on that platform. */
export function resolveAccounts(draft: Draft, accounts: SocialAccount[]): { accounts: SocialAccount[]; missing: string[] } {
  const found: SocialAccount[] = [];
  const missing: string[] = [];
  for (const ref of draft.accounts) {
    const key = ref.toLowerCase() === "x" ? "twitter" : ref.toLowerCase();
    const match = accounts.filter((a) => a.active && (a.id === ref || a.platform.toLowerCase() === key));
    if (match.length) found.push(...match.filter((a) => !found.includes(a)));
    else missing.push(ref);
  }
  return { accounts: found, missing };
}

export function draftIssues(draft: Draft, accounts: SocialAccount[], now = new Date()): string[] {
  const issues: string[] = [];
  const { accounts: to, missing } = resolveAccounts(draft, accounts);
  if (missing.length) issues.push(`no connected account for ${missing.join(", ")}`);
  for (const a of to) {
    const limit = TEXT_LIMIT[a.platform.toLowerCase()];
    if (limit && draft.text.length > limit) issues.push(`${a.platform}: ${draft.text.length}/${limit} characters`);
    if (NEEDS_MEDIA.has(a.platform.toLowerCase()) && !draft.media?.length) issues.push(`${a.platform} needs an image or video (media:)`);
  }
  if (draft.when && !(new Date(draft.when) > now)) issues.push(`when ${draft.when} is not in the future`);
  return issues;
}

/** Create the post in Appeeky (it publishes now, or at `when`) and mark the draft sent. */
export async function sendDraft(api: AppeekyApi, draft: Draft & { file: string }, accounts: SocialAccount[], now = new Date()): Promise<string> {
  const { accounts: to } = resolveAccounts(draft, accounts);
  const created = await api.post<{ id: string; status: string }>("/social/posts", {
    content: draft.text,
    account_ids: to.map((a) => a.id),
    ...(draft.when ? { scheduled_for: new Date(draft.when).toISOString() } : {}),
    ...(draft.media?.length ? { media_urls: draft.media } : {}),
  });
  const { file, ...rest } = draft;
  await writeFile(file, YAML.stringify({ ...rest, status: "sent", postId: created.id, sentAt: now.toISOString() }, { lineWidth: 0 }));
  return created.id;
}
