---
name: appeeky-spec-visibility
description: Get an app named when people ask ChatGPT, Claude, Gemini or Perplexity for an app like it, and track its category chart rank, in an Appeeky Spec repo. Use when asked about AI visibility, AI search, LLM or GEO/AEO recommendations, "does ChatGPT recommend us", which questions to track, why a competitor is named instead, or how the app ranks in its category.
metadata:
  version: 1.0.0
---

# AI visibility and category rank with Appeeky Spec

Two ways people find an app outside a keyword search: they ask an AI assistant, or they browse the category chart. The spec records both and `verify` measures them around every push.

Run commands as `npx @appeeky/spec <command> --json`.

## AI visibility

### The model

- An **intent** is what someone wants: "fall asleep to rain sounds". Labels need 8+ characters.
- A **prompt** is one way to ask for it: "what app plays rain sounds to help me sleep". Prompts need 15+ characters.
- Both live in `appeeky.spec.yaml` under `aiVisibility.intents.<country>`. Appeeky AI Visibility asks each assistant every prompt on a schedule. It records whether the answer names the app, in what position, who else is named and which pages are cited.

Needs `APPEEKY_API_KEY` on a plan with AI Visibility.

### Set up

1. `visibility init`. If Appeeky already tracks intents, they are written into the spec. If not, Appeeky writes them from the store listing in the background; run `init` again a few minutes later.
2. Read the intents with the user. Keep the ones a real person of a persona would ask (see `personas` in the spec). Drop vague ones.
3. After the user approves the edits (in a pull request), run `visibility sync`. It only adds. It lists what exists only in Appeeky and archives it only with `--prune`, which you run only when the user asks.

Good prompts:

- Sound like a person typing: "best white noise app for a newborn", not "white noise app".
- Never contain the app's own name (that measures nothing) or a competitor's name.
- Each intent gets 2 to 4 prompts phrased differently: a question, a request for a list ("top 5…"), a comparison need ("an app like X but free" is fine without naming X).
- Use the storefront's language. A `de` intent gets German prompts written for German speakers, not translations.

### Read the results

`visibility pull` writes `appeeky/visibility/<country>.yaml`:

| Field | Meaning |
| --- | --- |
| `summary` | intents by status: `winning` (named in 25%+ of answers), `weak`, `missing`, `noData` (not scanned yet) |
| `intents[].you` | share of answers that name the app, averaged over the assistants, 0–100 |
| `intents[].byModel` | the same per assistant: one assistant can name you while another never does |
| `intents[].namedInstead` | who the assistants name instead, with their share |
| `sources` | pages the assistants cite (mostly Perplexity), most cited first; `yours: true` is the app's own site |
| `fixes` | open suggestions from Appeeky for an intent |

`appeeky/visibility/changes.md` keeps what moved between pulls: an intent that went from `missing` to `winning`, or the app's site starting to be cited.

### Improve it

Assistants repeat what the web says about an app. In order of what you can change:

1. **The listing.** The first lines of the description and the subtitle should say what the app does in the intent's words ("rain sounds for sleep", not "an immersive audio experience"). This is a normal listing change: propose it in a pull request and measure it like any release (see appeeky-spec).
2. **The app's own website.** A page per main use case, in plain words, with the app's name and store links. When `sources` shows the assistants cite pages like it from competitors, the same kind of page is the gap.
3. **Cited third-party pages.** `sources` lists them: review sites, Reddit threads, "best apps for…" articles. Tell the user which ones name the competitors in `namedInstead` but not the app. Getting listed there is the user's outreach, not something to fake.
4. **`fixes`.** Read each one. Propose the ones that are listing or website edits; summarize the rest for the user.

Never write fake reviews, posts or comments, and never make claims the app does not live up to. Assistants also read those.

### Measure it

`verify` reads Appeeky's daily series as `ai_visibility`, the 0–1 share of answers that name the app. It compares the days before a push with the days after. Assistant answers change slowly and scans may be weekly, so a day-7 move is a hint and day 14 counts. `visibility scan` asks the assistants now. It uses AI Visibility credits: run it only when the user asks.

## Category rank

`category pull` adds today's rank in the category chart (top 100) for each storefront to `appeeky/category.csv`.

- **App Store:** reads Apple's chart, no key. The genre comes from the app, and a paid app is read from top-paid.
- **Google Play:** needs `APPEEKY_API_KEY` and `category.googlePlay` in the spec (e.g. `HEALTH_AND_FITNESS`). Ask the user for the category if it is not set.
- An empty rank means not in the top 100.

The rank mostly follows downloads, so it moves with everything: listing changes, ads, featuring, seasonality. Read it as a sign, not a cause:

- `verify` reads it as `category_rank`, where lower is better. When no target search moved and there is no analytics data, it decides the release (`decidedBy: ["category_rank"]`). Say so.
- A jump on the day an ad campaign started is the ad, not the listing. Check `appeeky ads` and `loops.md` first.
- It needs history: run it daily (the daily workflow does) so there are days before each push.
