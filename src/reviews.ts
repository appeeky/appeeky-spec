import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { AppeekyApi } from "./appeeky-api.js";
import { words } from "./text.js";
import { SPEC_DIR, SpecError } from "./files.js";
import type { MetricSource, MetricWindow } from "./metrics.js";
import type { StoreId } from "./schema.js";

/**
 * Customer reviews in the repo, so an agent can read what users say next to the
 * listing, and answer them through a pull request like any other change.
 *
 *   appeeky/reviews/<store>/<YYYY-MM>.jsonl   one review per line, newest first
 *   appeeky/reviews/summary.md                ratings, replies, versions, last 30 days
 *   appeeky/reviews/replies/<id>.yaml         a reply: drafted, reviewed in a PR, then sent
 *
 * Reviews come from the store connections in Appeeky (APPEEKY_API_KEY).
 */

export interface Review {
  id: string;
  store: StoreId;
  rating: number;
  title?: string;
  body: string;
  author?: string;
  /** App Store territory (US) or Google Play language (en). */
  where?: string;
  version?: string;
  date: string;
  reply?: { body: string; date?: string };
}

export function reviewsDir(root: string): string {
  return join(root, SPEC_DIR, "reviews");
}

// ── Pull ────────────────────────────────────────────────────────────────────

interface AscReviewRow {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  reviewer_nickname: string | null;
  territory: string | null;
  app_version: string | null;
  review_created_at: string;
  response_body: string | null;
  response_last_modified: string | null;
}

interface PlayReviewRow {
  review_id: string;
  author_name: string | null;
  reviewer_language: string | null;
  star_rating: number;
  review_text: string | null;
  review_last_modified_at: string;
  app_version_name: string | null;
  developer_reply_text: string | null;
  developer_reply_last_modified_at: string | null;
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as T;

export function fromAsc(r: AscReviewRow): Review {
  return clean({
    id: String(r.id),
    store: "app-store" as const,
    rating: r.rating,
    title: r.title ?? undefined,
    body: r.body ?? "",
    author: r.reviewer_nickname ?? undefined,
    where: r.territory ?? undefined,
    version: r.app_version ?? undefined,
    date: r.review_created_at,
    reply: r.response_body ? clean({ body: r.response_body, date: r.response_last_modified ?? undefined }) : undefined,
  });
}

export function fromPlay(r: PlayReviewRow): Review {
  return clean({
    id: String(r.review_id),
    store: "google-play" as const,
    rating: r.star_rating,
    body: r.review_text ?? "",
    author: r.author_name ?? undefined,
    where: r.reviewer_language ?? undefined,
    version: r.app_version_name ?? undefined,
    date: r.review_last_modified_at,
    reply: r.developer_reply_text ? clean({ body: r.developer_reply_text, date: r.developer_reply_last_modified_at ?? undefined }) : undefined,
  });
}

/** Newest reviews first, paging back until `since` (or `max` reviews). */
export async function fetchReviews(api: AppeekyApi, store: StoreId, appId: string, options: { since?: string; max?: number } = {}): Promise<Review[]> {
  const max = options.max ?? 2000;
  const out: Review[] = [];
  let before: string | undefined;
  while (out.length < max) {
    const query: Record<string, string> = { limit: "200", ...(before ? { before } : {}) };
    const page =
      store === "app-store"
        ? ((await api.get<{ reviews?: AscReviewRow[] }>("/connect/reviews", { ...query, appId }))?.reviews ?? []).map(fromAsc)
        : ((await api.get<{ reviews?: PlayReviewRow[] }>("/connect/google-play/reviews", { ...query, packageName: appId }))?.reviews ?? []).map(fromPlay);
    const fresh = options.since ? page.filter((r) => r.date >= options.since!) : page;
    out.push(...fresh);
    if (page.length < 200 || fresh.length < page.length) break;
    before = page[page.length - 1]!.date;
  }
  return out.slice(0, max);
}

const monthOf = (iso: string) => iso.slice(0, 7);

export async function readReviews(root: string, store?: StoreId): Promise<Review[]> {
  const out: Review[] = [];
  for (const s of store ? [store] : (["app-store", "google-play"] as StoreId[])) {
    const dir = join(reviewsDir(root), s);
    if (!existsSync(dir)) continue;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort()) {
      for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
        if (line.trim()) out.push(JSON.parse(line) as Review);
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Merge fetched reviews into the monthly files: a review that changed (edited,
 * answered) replaces the old line. Returns how many were new and how many changed.
 */
export async function saveReviews(root: string, fetched: Review[]): Promise<{ added: number; updated: number }> {
  const existing = new Map((await readReviews(root)).map((r) => [`${r.store}:${r.id}`, r]));
  let added = 0;
  let updated = 0;
  for (const r of fetched) {
    const key = `${r.store}:${r.id}`;
    const old = existing.get(key);
    if (!old) added++;
    else if (JSON.stringify(old) !== JSON.stringify(r)) updated++;
    existing.set(key, r);
  }
  const files = new Map<string, Review[]>();
  for (const r of existing.values()) {
    const file = join(reviewsDir(root), r.store, `${monthOf(r.date)}.jsonl`);
    files.set(file, [...(files.get(file) ?? []), r]);
  }
  for (const [file, rows] of files) {
    await mkdir(join(file, ".."), { recursive: true });
    rows.sort((a, b) => b.date.localeCompare(a.date));
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return { added, updated };
}

// ── Summary ─────────────────────────────────────────────────────────────────

export interface ReviewStats {
  count: number;
  average: number | null;
  /** Share of 1- and 2-star reviews. */
  low: number | null;
  unanswered: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export function reviewStats(reviews: Review[]): ReviewStats {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as ReviewStats["distribution"];
  for (const r of reviews) if (r.rating >= 1 && r.rating <= 5) distribution[r.rating as 1 | 2 | 3 | 4 | 5]++;
  const count = reviews.length;
  return {
    count,
    average: count ? reviews.reduce((n, r) => n + r.rating, 0) / count : null,
    low: count ? (distribution[1] + distribution[2]) / count : null,
    unanswered: reviews.filter((r) => !r.reply).length,
    distribution,
  };
}

const fmt = (n: number | null, digits = 2) => (n === null ? "—" : n.toFixed(digits));
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

/** `appeeky/reviews/summary.md`: what users say, in numbers, for people and agents. */
// Words that say nothing about what users want.
const STOP = new Set(
  "a an and are as at be but by can do does for from get got has have i if in is it its it's just me my no not of on or so that the this to too was we were what when with would you your app apps very really love like great good nice best please thanks thank use using used one all also only much more can't don't doesn't didn't i'm ive i've it's".split(" "),
);

/**
 * What users ask for in their own words: words and two-word phrases that come up in three or
 * more reviews and appear nowhere in your listing. Candidates for targets, or for the product.
 * English stop words only, so other languages show more noise.
 */
export function reviewPhrases(reviews: Review[], listingText: string, limit = 10): Array<{ phrase: string; reviews: number; low: number }> {
  const listing = ` ${words(listingText).join(" ")} `;
  const counts = new Map<string, { reviews: number; low: number }>();
  for (const r of reviews) {
    const ws = words(`${r.title ?? ""} ${r.body}`).filter((w) => w.length > 2);
    const seen = new Set<string>();
    for (let i = 0; i < ws.length; i++) {
      if (!STOP.has(ws[i]!)) seen.add(ws[i]!);
      if (i + 1 < ws.length && !STOP.has(ws[i]!) && !STOP.has(ws[i + 1]!)) seen.add(`${ws[i]} ${ws[i + 1]}`);
    }
    for (const p of seen) {
      const c = counts.get(p) ?? { reviews: 0, low: 0 };
      c.reviews++;
      if (r.rating <= 3) c.low++;
      counts.set(p, c);
    }
  }
  const ranked = [...counts.entries()]
    .filter(([p, c]) => c.reviews >= 3 && !listing.includes(` ${p} `))
    // A phrase beats its own words when it is nearly as common.
    .sort((a, b) => b[1].reviews + (b[0].includes(" ") ? 1 : 0) - (a[1].reviews + (a[0].includes(" ") ? 1 : 0)));
  const out: Array<{ phrase: string; reviews: number; low: number }> = [];
  for (const [phrase, c] of ranked) {
    if (out.some((o) => o.phrase.split(" ").includes(phrase) && o.reviews >= c.reviews * 0.7)) continue;
    out.push({ phrase, ...c });
    if (out.length >= limit) break;
  }
  return out;
}

export function summaryMarkdown(reviews: Review[], now = new Date(), listingText = ""): string {
  const day = 86_400_000;
  const recentFrom = new Date(now.getTime() - 30 * day).toISOString();
  const prevFrom = new Date(now.getTime() - 60 * day).toISOString();
  const lines = ["# Reviews", "", `Pulled ${now.toISOString().slice(0, 10)}. Written by \`appeeky-spec reviews pull\`; do not edit by hand.`, ""];
  for (const store of ["app-store", "google-play"] as StoreId[]) {
    const all = reviews.filter((r) => r.store === store);
    if (all.length === 0) continue;
    const recent = reviewStats(all.filter((r) => r.date >= recentFrom));
    const prev = reviewStats(all.filter((r) => r.date >= prevFrom && r.date < recentFrom));
    const total = reviewStats(all);
    lines.push(`## ${store === "app-store" ? "App Store" : "Google Play"}`, "");
    lines.push("| | reviews | average | 1–2 stars | unanswered |", "| --- | --- | --- | --- | --- |");
    lines.push(`| last 30 days | ${recent.count} | ${fmt(recent.average)} | ${pct(recent.low)} | ${recent.unanswered} |`);
    lines.push(`| 30 days before | ${prev.count} | ${fmt(prev.average)} | ${pct(prev.low)} | ${prev.unanswered} |`);
    lines.push(`| all pulled | ${total.count} | ${fmt(total.average)} | ${pct(total.low)} | ${total.unanswered} |`, "");
    lines.push(`Stars: ${[5, 4, 3, 2, 1].map((s) => `${s}★ ${total.distribution[s as 1]}`).join(" · ")}`, "");
    const versions = new Map<string, Review[]>();
    for (const r of all) if (r.version) versions.set(r.version, [...(versions.get(r.version) ?? []), r]);
    const byVersion = [...versions.entries()].sort((a, b) => (b[1][0]!.date > a[1][0]!.date ? 1 : -1)).slice(0, 5);
    if (byVersion.length) {
      lines.push("| version | reviews | average | 1–2 stars |", "| --- | --- | --- | --- |");
      for (const [v, rs] of byVersion) {
        const s = reviewStats(rs);
        lines.push(`| ${v} | ${s.count} | ${fmt(s.average)} | ${pct(s.low)} |`);
      }
      lines.push("");
    }
    const waiting = all.filter((r) => !r.reply && r.rating <= 2).slice(0, 5);
    if (waiting.length) {
      lines.push("Low ratings without a reply:", "");
      for (const r of waiting) lines.push(`- \`${r.id}\` ${r.rating}★ ${r.date.slice(0, 10)}${r.where ? ` ${r.where}` : ""}: ${(r.title ? `${r.title}. ` : "") + r.body.replace(/\s+/g, " ").slice(0, 140)}`);
      lines.push("");
    }
  }
  const phrases = listingText ? reviewPhrases(reviews, listingText) : [];
  if (phrases.length) {
    lines.push("## Words users use that your listing does not", "");
    lines.push("Candidates for targets (check their popularity with `suggest`), or things to build. From reviews in both stores.", "");
    lines.push("| words | reviews | of them 1–3 stars |", "| --- | --- | --- |");
    for (const p of phrases) lines.push(`| ${p.phrase} | ${p.reviews} | ${p.low} |`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeSummary(root: string, now = new Date(), listingText = ""): Promise<string> {
  const file = join(reviewsDir(root), "summary.md");
  await mkdir(reviewsDir(root), { recursive: true });
  await writeFile(file, summaryMarkdown(await readReviews(root), now, listingText));
  return file;
}

// ── Replies ─────────────────────────────────────────────────────────────────

export const replySchema = z
  .object({
    id: z.string().min(1),
    store: z.enum(["app-store", "google-play"]),
    /** The review being answered, for whoever reviews the pull request. */
    review: z.string().optional(),
    text: z.string().min(1),
    status: z.enum(["draft", "sent"]).default("draft"),
    sentAt: z.string().optional(),
  })
  .strict();

export type Reply = z.infer<typeof replySchema>;

export const repliesDir = (root: string) => join(reviewsDir(root), "replies");

export async function writeReply(root: string, reply: z.input<typeof replySchema>): Promise<string> {
  const parsed = replySchema.parse(reply);
  await mkdir(repliesDir(root), { recursive: true });
  const file = join(repliesDir(root), `${parsed.store}-${parsed.id}.yaml`);
  await writeFile(file, YAML.stringify(parsed, { lineWidth: 0 }));
  return file;
}

export async function readReplies(root: string): Promise<Array<Reply & { file: string }>> {
  const dir = repliesDir(root);
  if (!existsSync(dir)) return [];
  const out: Array<Reply & { file: string }> = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort()) {
    const parsed = replySchema.safeParse(YAML.parse(await readFile(join(dir, f), "utf8")));
    if (!parsed.success) throw new SpecError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), join(dir, f));
    out.push({ ...parsed.data, file: join(dir, f) });
  }
  return out;
}

/** Store limits for a developer reply. */
export const REPLY_LIMIT: Record<StoreId, number> = { "app-store": 5970, "google-play": 350 };

export function replyIssues(reply: Reply): string[] {
  const issues: string[] = [];
  if (reply.text.length > REPLY_LIMIT[reply.store]) issues.push(`${reply.text.length}/${REPLY_LIMIT[reply.store]} characters`);
  return issues;
}

/** Send one draft reply to the store and mark it sent. */
export async function sendReply(api: AppeekyApi, reply: Reply & { file: string }, packageName: string | undefined, now = new Date()): Promise<void> {
  if (reply.store === "app-store") {
    await api.post(`/connect/reviews/${encodeURIComponent(reply.id)}/response`, { responseBody: reply.text });
  } else {
    if (!packageName) throw new Error("googlePlay.packageName is not set in appeeky.spec.yaml");
    await api.post(`/connect/google-play/apps/${encodeURIComponent(packageName)}/reviews/${encodeURIComponent(reply.id)}/reply`, { replyText: reply.text });
  }
  const { file, ...rest } = reply;
  await writeFile(file, YAML.stringify({ ...rest, status: "sent", sentAt: now.toISOString() }, { lineWidth: 0 }));
}

// ── Measuring ───────────────────────────────────────────────────────────────

/** Ratings around a push, from the pulled review files: no API call. */
export function reviewMetricSource(root: string): MetricSource {
  return {
    label: "Reviews in the repo",
    async window(store, _appId, from, to) {
      const rs = (await readReviews(root, store)).filter((r) => r.date >= from && r.date < to);
      // A handful of reviews says nothing about a change.
      if (rs.length < 5) return null;
      const s = reviewStats(rs);
      const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
      const values: MetricWindow["values"] = { rating: s.average!, low_ratings: s.low! };
      return { from, to, days, values };
    },
  };
}
