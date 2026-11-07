---
name: appeeky-spec-targets
description: Choose and prioritize the searches an app should be found for (the `targets` in appeeky.spec.yaml), from personas, competitors and keyword popularity. Use when asked which keywords to target, to do keyword research, to fill or clean up targets, to define personas, or to react to a competitor changing its title or subtitle.
metadata:
  version: 1.0.0
---

# Choose targets with Appeeky Spec

`targets` in `appeeky.spec.yaml` are the searches the app should be found for, per storefront. Coverage, suggestions, rank baselines and release verdicts are all measured against them, so wrong targets make every later step wrong. Pick them before editing any listing.

Run commands as `npx @appeeky/spec <command> --json`.

## 1. Start from people, not words

Write down who the app is for as `personas`, with how each one searches:

```yaml
personas:
  - id: new-parents
    name: New parents
    description: Need their baby to fall asleep, often at night with one hand free.
    searches: [baby sleep sounds, white noise baby, lullaby]
```

Ask the user when you cannot tell from the repo, website or current listing. `searches` are seeds, not final targets. Experiments refer to personas by id.

The same personas are the source of the AI visibility intents (`aiVisibility.intents`, see appeeky-spec-visibility). A persona's need ("fall asleep to rain sounds") is an intent. How they would ask an assistant is a prompt; it is longer and more conversational than a store search.

## 2. Collect candidates

From, in this order:

1. The personas' `searches`.
2. `suggest --json`: missing target words and Appeeky keyword ideas (with `APPEEKY_API_KEY`).
3. Competitors: `competitors pull` writes the searches each competitor ranks best for to `appeeky/competitors/`, and what the top apps for the seed searches put in their titles and subtitles. With the Appeeky MCP server connected, use its keyword and competitor tools for popularity, difficulty, rankings and recent metadata changes.
4. Store search suggestions in the storefront's language.

Drop other apps' brand names and trademarks, generic one-word terms the category giants own ("music", "photo"), and searches the app does not actually serve.

## 3. Prioritize

For each candidate, look at popularity (how many search it), difficulty (how strong the apps ranking for it are) and relevance (would someone searching this install this app?).

- Relevance first: an irrelevant search that ranks still does not convert.
- Prefer specific phrases with decent popularity over head terms a small app cannot reach ("screenshot organizer" over "screenshot").
- Keep about 5 to 15 targets per storefront. More cannot be covered by a 30 + 30 + 100 character listing and cannot be measured clearly.
- Put the most important target first; it should go in the name or the title.

## 4. Write them

```yaml
targets:
  us: [screenshot organizer, screenshot search, screenshot manager]
  de: [screenshots organisieren, bildschirmfotos suchen]
```

Then `coverage --json`: anything `missing` is the next listing change (see appeeky-spec). Each language market needs its own research, never translated targets (see appeeky-spec-localize).

## Competitor moves

When a competitor drops a word from its title or subtitle, the search can open up; when it adds one of your targets, expect pressure on that rank. Check whether the word is one of your targets and how your rank moves, and propose a listing change only for a target that matters. Desktop lists these under ASO → Competitor moves.

## Changing targets later

Targets are the yardstick of every release. Change them deliberately, say why in the commit, and do not swap targets in the same release as a listing change you want to measure.
