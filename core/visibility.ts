/**
 * AI visibility on the user's own model keys: the same pipeline as Appeeky AI Visibility, run where
 * Spec runs. Bundled and minified into vendor/visibility-core.js by scripts/vendor-visibility-core.mjs;
 * the source ships nowhere else.
 *
 *   ask       one prompt to one assistant, with web search, the way the consumer apps answer
 *   extract   a second, cheap call that lists the apps the answer names, in order
 *   score     per intent and assistant: how often the app is named, where, and who is named instead
 *   generate  intents and prompts from the listing, for a first scan
 *
 * Web search answers are parsed by Appeeky's own parsers (aliased at bundle time).
 */
import { parseAnthropicMessagesAnswer, parseGeminiGroundedAnswer, parseOpenAIResponsesAnswer } from "@appeeky/visibility-parsers";

export type Model = "chatgpt" | "claude" | "gemini" | "perplexity";
export const MODELS: Model[] = ["chatgpt", "claude", "gemini", "perplexity"];

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export interface Provider {
  model: Model;
  /** Environment variables that hold the key, first match wins. */
  env: string[];
  modelId: string;
  /** Rough cost of one answer with web search, in USD, for the quote. */
  estimateUsd: number;
}

export const PROVIDERS: Record<Model, Provider> = {
  chatgpt: { model: "chatgpt", env: ["OPENAI_API_KEY"], modelId: "gpt-4.1", estimateUsd: 0.035 },
  claude: { model: "claude", env: ["ANTHROPIC_API_KEY"], modelId: "claude-haiku-5-5", estimateUsd: 0.015 },
  gemini: { model: "gemini", env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], modelId: "gemini-2.5-flash", estimateUsd: 0.04 },
  perplexity: { model: "perplexity", env: ["PERPLEXITY_API_KEY"], modelId: "sonar", estimateUsd: 0.008 },
};

/** The second pass and the generators use the cheapest model of whichever key is set. */
const HELPERS: Array<{ model: Model; modelId: string; estimateUsd: number }> = [
  { model: "chatgpt", modelId: "gpt-4.1-mini", estimateUsd: 0.001 },
  { model: "gemini", modelId: "gemini-2.5-flash", estimateUsd: 0.001 },
  { model: "claude", modelId: "claude-haiku-5-5", estimateUsd: 0.002 },
];

export function keyFor(model: Model, env: Env): string | undefined {
  for (const name of PROVIDERS[model].env) if (env[name]?.trim()) return env[name]!.trim();
  return undefined;
}

export function availableModels(env: Env, wanted: Model[] = MODELS): Model[] {
  return wanted.filter((m) => keyFor(m, env));
}

export function helperFor(env: Env): { model: Model; modelId: string; key: string; estimateUsd: number } | null {
  for (const h of HELPERS) {
    const key = keyFor(h.model, env);
    if (key) return { ...h, key };
  }
  return null;
}

/** USD for a scan: every prompt to every assistant, plus one extraction per answer. */
export function quoteScan(prompts: number, models: Model[], env: Env): number {
  const helper = helperFor(env);
  const per = models.reduce((n, m) => n + PROVIDERS[m].estimateUsd + (helper?.estimateUsd ?? 0), 0);
  return Math.round(prompts * per * 100) / 100;
}

// ── HTTP ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST JSON; 429 and 5xx are retried with backoff (honouring Retry-After). */
async function post(fetcher: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120_000): Promise<any> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    last = `${res.status} ${errorText(text)}`;
    if (res.status !== 429 && res.status < 500) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 2000 * 2 ** attempt);
  }
  throw new Error(last);
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    return (typeof e === "string" ? e : e?.message) ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

// ── Ask ─────────────────────────────────────────────────────────────

export interface Citation {
  url: string;
  title?: string;
}

export interface Answer {
  model: Model;
  modelId: string;
  status: "ok" | "refusal" | "error";
  text: string;
  citations: Citation[];
  costUsd: number;
  error?: string;
}

const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  sonar: { in: 1, out: 1 },
};
const SEARCH_USD: Partial<Record<Model, number>> = { chatgpt: 0.025, claude: 0.01, gemini: 0.035, perplexity: 0.005 };

const tokenCost = (modelId: string, inTok: number, outTok: number) => {
  const p = PRICES[modelId];
  return p ? (inTok * p.in + outTok * p.out) / 1_000_000 : 0;
};

function systemPrompt(country: string, language: string): string {
  return `You are a helpful assistant recommending mobile apps.
The user is in ${country.toUpperCase()} and writes in ${language.toUpperCase()}.
When the user asks for an app, return a short ranked list (1–5) of real,
currently-available apps. For each app: state its name first, then a
one-sentence reason. Prefer iOS App Store apps. Be specific — name the
exact app, not a category. If you genuinely cannot recommend any app,
say so plainly.`;
}

function isRefusal(text: string): boolean {
  const t = text.toLowerCase();
  return ["i can't recommend", "i cannot recommend", "i'm unable to recommend", "i am unable to recommend"].some((s) => t.includes(s)) || t.startsWith("i'm sorry") || t.startsWith("sorry, i");
}

/** Claude 5 models reject temperature and think before answering; thinking counts against max_tokens. */
const claudeLimits = (modelId: string) => (/claude-[a-z]+-5/.test(modelId) ? { max_tokens: 16_000 } : { max_tokens: 1500, temperature: 0.4 });

export async function ask(model: Model, key: string, input: { prompt: string; country: string; language: string }, fetcher: Fetch = fetch): Promise<Answer> {
  const modelId = PROVIDERS[model].modelId;
  const system = systemPrompt(input.country, input.language);
  try {
    let text = "";
    let citations: Citation[] = [];
    let cost = 0;
    if (model === "chatgpt") {
      const body = await post(fetcher, "https://api.openai.com/v1/responses", { authorization: `Bearer ${key}` }, {
        model: modelId,
        instructions: system,
        input: input.prompt,
        temperature: 0.4,
        tools: [{ type: "web_search_preview", search_context_size: "low" }],
      });
      const p = parseOpenAIResponsesAnswer(body);
      ({ text, citations } = p);
      cost = tokenCost(modelId, p.inputTokens, p.outputTokens) + SEARCH_USD.chatgpt! * Math.max(1, p.searchCalls);
    } else if (model === "claude") {
      const body = await post(fetcher, "https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
        model: modelId,
        ...claudeLimits(modelId),
        system,
        messages: [{ role: "user", content: input.prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      });
      const p = parseAnthropicMessagesAnswer(body);
      ({ text, citations } = p);
      cost = tokenCost(modelId, p.inputTokens, p.outputTokens) + SEARCH_USD.claude! * Math.max(1, p.searchCalls);
    } else if (model === "gemini") {
      const body = await post(fetcher, `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`, { "x-goog-api-key": key }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.4 },
      });
      const cand = body?.candidates?.[0];
      const raw = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      const p = parseGeminiGroundedAnswer({ text: raw, groundingMetadata: cand?.groundingMetadata });
      ({ text, citations } = p);
      const u = body?.usageMetadata ?? {};
      cost = tokenCost(modelId, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) + (p.searchCalls > 0 ? SEARCH_USD.gemini! : 0);
    } else {
      const body = await post(fetcher, "https://api.perplexity.ai/chat/completions", { authorization: `Bearer ${key}` }, {
        model: modelId,
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input.prompt },
        ],
      });
      text = body?.choices?.[0]?.message?.content ?? "";
      const raw: unknown[] = Array.isArray(body?.search_results) && body.search_results.length ? body.search_results : Array.isArray(body?.citations) ? body.citations : [];
      citations = raw
        .map((c) => (typeof c === "string" ? { url: c } : c && typeof (c as Citation).url === "string" ? { url: (c as Citation).url, title: (c as Citation).title } : null))
        .filter((c): c is Citation => c !== null);
      cost = tokenCost(modelId, body?.usage?.prompt_tokens ?? 0, body?.usage?.completion_tokens ?? 0) + SEARCH_USD.perplexity!;
    }
    return { model, modelId, status: isRefusal(text) ? "refusal" : "ok", text, citations, costUsd: cost };
  } catch (e) {
    return { model, modelId, status: "error", text: "", citations: [], costUsd: 0, error: (e as Error).message };
  }
}

// ── JSON from the helper model ──────────────────────────────────────

function firstJson(text: string): any {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("no JSON in the answer");
  return JSON.parse(text.slice(s, e + 1));
}

/** One JSON object from the helper model, with the provider's JSON mode where it has one. */
export async function helperJson(helper: { model: Model; modelId: string; key: string }, prompt: string, temperature: number, fetcher: Fetch = fetch): Promise<{ json: any; costUsd: number }> {
  if (helper.model === "chatgpt") {
    const body = await post(fetcher, "https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${helper.key}` }, {
      model: helper.modelId,
      temperature,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });
    return { json: firstJson(body?.choices?.[0]?.message?.content ?? ""), costUsd: tokenCost(helper.modelId, body?.usage?.prompt_tokens ?? 0, body?.usage?.completion_tokens ?? 0) };
  }
  if (helper.model === "gemini") {
    const body = await post(fetcher, `https://generativelanguage.googleapis.com/v1beta/models/${helper.modelId}:generateContent`, { "x-goog-api-key": helper.key }, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: "application/json" },
    });
    const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    const u = body?.usageMetadata ?? {};
    return { json: firstJson(text), costUsd: tokenCost(helper.modelId, u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) };
  }
  const body = await post(fetcher, "https://api.anthropic.com/v1/messages", { "x-api-key": helper.key, "anthropic-version": "2023-06-01" }, {
    model: helper.modelId,
    ...claudeLimits(helper.modelId),
    messages: [{ role: "user", content: `${prompt}\n\nAnswer with the JSON object only.` }],
  });
  const text = (body?.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  return { json: firstJson(text), costUsd: tokenCost(helper.modelId, body?.usage?.input_tokens ?? 0, body?.usage?.output_tokens ?? 0) };
}

// ── Extract ─────────────────────────────────────────────────────────

export interface Mention {
  name: string;
  position: number | null;
  /** 0-based index into the answer's citations. */
  citation: number | null;
}

function extractionPrompt(input: { answer: string; prompt: string; owner: string; competitors: string[]; citations: Citation[] }): string {
  const competitors = input.competitors.length ? `\nKnown competitor apps: ${input.competitors.slice(0, 10).join(", ")}` : "";
  const citations = input.citations.length
    ? `\n\nCitations available (0-indexed):\n${input.citations
        .slice(0, 10)
        .map((c, i) => `  [${i}] ${c.title ?? c.url}`)
        .join("\n")}`
    : "";
  return `You parse a recommendation answer from an AI assistant and extract
which mobile apps were mentioned, and in which position.

Original user prompt:
  """${input.prompt}"""

The user owns this app (recognise it even with minor spelling variants):
  "${input.owner}"${competitors}

Assistant's answer:
  """${input.answer.slice(0, 8000)}"""${citations}

Return JSON: {"refusal": boolean, "apps": [{"appName": string, "position": number|null, "citationIndex": number|null}]}

Rules:
- "apps" lists each app the assistant mentioned in their recommendation,
  in the order the assistant presented them.
- position: 1-based rank when the assistant gave a numbered or ordered
  list. null when the answer is conversational prose with no clear ranking.
- citationIndex: if the assistant cited source [N] for that app, return
  N-1 (0-indexed into the Citations list above). null otherwise.
- If the assistant refused or said it couldn't recommend apps, set
  refusal=true and apps=[].
- Do NOT invent apps the assistant didn't mention. Do NOT include
  generic phrases like "an app for X" — only specific named apps.
- Strip explanatory parentheses from appName (return "Calm" not
  "Calm (popular meditation app)").
- App names should be the brand the assistant used.`;
}

export async function extract(
  helper: { model: Model; modelId: string; key: string },
  input: { answer: string; prompt: string; owner: string; competitors: string[]; citations: Citation[] },
  fetcher: Fetch = fetch,
): Promise<{ refusal: boolean; mentions: Mention[]; costUsd: number }> {
  const { json, costUsd } = await helperJson(helper, extractionPrompt(input), 0, fetcher);
  const apps: unknown[] = Array.isArray(json?.apps) ? json.apps : [];
  const mentions = apps
    .map((a) => a as { appName?: unknown; position?: unknown; citationIndex?: unknown })
    .filter((a) => typeof a.appName === "string" && a.appName.trim())
    .map((a) => ({
      name: (a.appName as string).trim(),
      position: typeof a.position === "number" && a.position >= 1 ? Math.round(a.position) : null,
      citation: typeof a.citationIndex === "number" && a.citationIndex >= 0 ? Math.round(a.citationIndex) : null,
    }));
  return { refusal: Boolean(json?.refusal), mentions, costUsd };
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Whether a named app is the user's app: the name, or the part before a colon or dash ("Rain: Sleep Sounds" → "Rain"). */
export function isOwner(name: string, titles: string[]): boolean {
  const a = squash(name);
  if (!a) return false;
  return titles.some((t) => {
    const forms = [t, t.split(/\s[:\-–—|]\s|:\s/)[0] ?? t].map(squash).filter((x) => x.length >= 3);
    // A longer mention may contain the name ("Sleep Sounds app"); a shorter one must be most of it, so "Sleep" is not "Sleep Sounds".
    return forms.some((b) => a === b || (b.length >= 4 && (a.includes(b) || (b.includes(a) && a.length >= b.length * 0.7))));
  });
}

// ── Score ───────────────────────────────────────────────────────────

export const WINNING_PCT = 25;

export interface ScoredAnswer {
  intent: string;
  prompt: string;
  model: Model;
  status: Answer["status"];
  mentions: Mention[];
  citations: Citation[];
}

export interface IntentScore {
  label: string;
  status: "missing" | "weak" | "winning" | "no_data";
  you?: number;
  byModel: Partial<Record<Model, { pct: number; position: number | null; prompts: number }>>;
  namedInstead: Array<{ name: string; pct: number; models: Model[] }>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Per intent: the share of answered prompts that name the app, per assistant and averaged, and who is named instead. */
export function score(answers: ScoredAnswer[], intents: string[], owner: string[]): IntentScore[] {
  return intents.map((label) => {
    const mine = answers.filter((a) => a.intent === label && (a.status === "ok" || a.status === "refusal"));
    const byModel: IntentScore["byModel"] = {};
    for (const model of MODELS) {
      const rows = mine.filter((a) => a.model === model);
      if (!rows.length) continue;
      const hits = rows.map((a) => a.mentions.find((m) => isOwner(m.name, owner))).filter((m): m is Mention => Boolean(m));
      const positions = hits.map((m) => m.position).filter((p): p is number => p !== null);
      byModel[model] = {
        pct: round1((hits.length / rows.length) * 100),
        position: positions.length ? round1(positions.reduce((n, p) => n + p, 0) / positions.length) : null,
        prompts: rows.length,
      };
    }
    const stats = Object.values(byModel);
    const you = stats.length ? round1(stats.reduce((n, s) => n + s!.pct, 0) / stats.length) : undefined;
    const others = new Map<string, { name: string; count: number; models: Set<Model> }>();
    for (const a of mine) {
      for (const m of a.mentions) {
        if (isOwner(m.name, owner)) continue;
        const k = squash(m.name);
        const o = others.get(k) ?? { name: m.name, count: 0, models: new Set<Model>() };
        o.count++;
        o.models.add(a.model);
        others.set(k, o);
      }
    }
    const namedInstead = [...others.values()]
      .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
      .slice(0, 5)
      .map((o) => ({ name: o.name, pct: mine.length ? Math.min(100, round1((o.count / mine.length) * 100)) : 0, models: [...o.models] }));
    const status = you === undefined ? "no_data" : you >= WINNING_PCT ? "winning" : you > 0 ? "weak" : "missing";
    return { label, status, you, byModel, namedInstead };
  });
}

/** Cited domains across the answers, most cited first; `yours` when it is the app's own site. */
export function citedDomains(answers: ScoredAnswer[], ownDomains: string[]): Array<{ domain: string; count: number; url: string; yours?: true }> {
  const own = ownDomains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  const out = new Map<string, { domain: string; count: number; url: string; yours?: true }>();
  for (const a of answers) {
    for (const c of a.citations) {
      let domain: string;
      try {
        domain = new URL(c.url).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        continue;
      }
      // Gemini cites through Google redirect links; their title is the source domain.
      if (domain.endsWith("vertexaisearch.cloud.google.com") && c.title && /^[\w.-]+\.[a-z]{2,}$/i.test(c.title)) domain = c.title.toLowerCase().replace(/^www\./, "");
      const row = out.get(domain) ?? { domain, count: 0, url: c.url };
      row.count++;
      if (own.some((d) => domain === d || domain.endsWith(`.${d}`))) row.yours = true;
      out.set(domain, row);
    }
  }
  return [...out.values()].sort((x, y) => y.count - x.count || x.domain.localeCompare(y.domain));
}

// ── Generate ────────────────────────────────────────────────────────

export interface AppContext {
  title: string;
  subtitle?: string;
  description?: string;
  keywords?: string[];
  competitors?: string[];
  country: string;
  language: string;
}

function intentsPrompt(app: AppContext, max: number, exclude: string[]): string {
  return `You map a mobile app to the *user intents* it serves — the goals
real users would ask an AI assistant (like ChatGPT, Gemini, or
Perplexity) about. Each intent is a short user-meaningful goal,
NOT an app feature.

App: ${app.title}${app.subtitle ? `\nSubtitle: ${app.subtitle}` : ""}${app.description ? `\nDescription (first 700 chars): ${app.description.slice(0, 700)}` : ""}${
    app.keywords?.length ? `\nTarget keywords: ${app.keywords.slice(0, 20).join(", ")}` : ""
  }

Country: ${app.country.toUpperCase()}
Language: ${app.language.toUpperCase()}${exclude.length ? `\n\nALREADY DEFINED (do NOT propose duplicates or near-duplicates):\n- ${exclude.slice(0, 30).join("\n- ")}` : ""}

Return JSON: {"intents": [{"label": string, "description": string}]}

Rules:
- Propose between 4 and ${max} distinct intents.
- Phrase each intent from the USER's point of view, in sentence-case,
  starting with a verb when natural ("Fall asleep faster and unwind"). 4–10 words.
- Each intent must be something a real user would type into an AI
  assistant — NOT marketing copy and NOT a literal feature name.
- Cover a healthy mix: core use-cases, related needs the app can satisfy,
  problem-driven goals, and at least one comparison/alternative angle when applicable.
- Write labels in the storefront's language.
- Description (1 sentence, max 200 chars): what kind of user has this
  intent and what they want the assistant to recommend.`;
}

function promptsPrompt(app: AppContext, intent: { label: string; description?: string }, count: number): string {
  return `You write realistic prompts that everyday users would type into an
AI assistant (ChatGPT, Gemini, Perplexity) when looking for a mobile app.

Intent to cover:
  "${intent.label}"${intent.description ? `\n  ${intent.description}` : ""}

App context (the app whose visibility we're measuring):
  Title: ${app.title}${app.subtitle ? `\n  Subtitle: ${app.subtitle}` : ""}${app.competitors?.length ? `\nKnown competitor apps (use in comparison prompts where natural): ${app.competitors.slice(0, 6).join(", ")}` : ""}

Country: ${app.country.toUpperCase()}
Language: ${app.language.toUpperCase()}

Return JSON: {"prompts": [string]}

Rules:
- Produce ${count} prompts that cover the intent from different angles:
  a pure category query, a problem-first one ("I struggle with…"),
  a scenario ("an app for my morning routine"), and where natural an
  "alternative to X" comparison. Never name the app being measured.
- Write the way a casual user types, in the storefront's language:
  conversational, lower-case is fine. Length 8–35 words.
- Do NOT mention that you're an AI or test prompts. No emojis.`;
}

const fingerprint = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).sort().join(" ");

export async function generateIntents(
  helper: { model: Model; modelId: string; key: string },
  app: AppContext,
  opts: { maxIntents?: number; promptsPerIntent?: number; exclude?: string[] } = {},
  fetcher: Fetch = fetch,
): Promise<{ intents: Array<{ label: string; description?: string; prompts: string[] }>; costUsd: number }> {
  const max = opts.maxIntents ?? 6;
  const first = await helperJson(helper, intentsPrompt(app, max, opts.exclude ?? []), 0.7, fetcher);
  let cost = first.costUsd;
  const seen = new Set((opts.exclude ?? []).map(fingerprint));
  const picked: Array<{ label: string; description?: string }> = [];
  for (const i of Array.isArray(first.json?.intents) ? first.json.intents : []) {
    if (typeof i?.label !== "string" || i.label.trim().length < 4) continue;
    const fp = fingerprint(i.label);
    if (seen.has(fp)) continue;
    seen.add(fp);
    picked.push({ label: i.label.trim(), description: typeof i.description === "string" ? i.description.trim() : undefined });
    if (picked.length >= max) break;
  }
  const out: Array<{ label: string; description?: string; prompts: string[] }> = [];
  for (const intent of picked) {
    const r = await helperJson(helper, promptsPrompt(app, intent, opts.promptsPerIntent ?? 4), 0.8, fetcher);
    cost += r.costUsd;
    const owner = squash(app.title.split(/[:\-–—|]/)[0] ?? app.title);
    const prompts = [...new Set((Array.isArray(r.json?.prompts) ? r.json.prompts : []).filter((p: unknown): p is string => typeof p === "string" && p.trim().length >= 15).map((p: string) => p.trim()))]
      .filter((p) => owner.length < 4 || !squash(p).includes(owner))
      .slice(0, opts.promptsPerIntent ?? 4) as string[];
    if (prompts.length) out.push({ ...intent, prompts });
  }
  return { intents: out, costUsd: cost };
}
