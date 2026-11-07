---
name: appeeky-spec-localize
description: Add or improve a store listing for a new language or country in an Appeeky Spec repo (appeeky.spec.yaml + appeeky/store). Use when asked to localize App Store or Google Play metadata, launch in a new country, add a locale, translate keywords, or use spare keyword space in secondary locales such as Spanish (Mexico) for the US.
metadata:
  version: 1.0.0
---

# Localize a listing with Appeeky Spec

Localizing is keyword research per market, not translation. People in each country search with their own words, and a literal translation of an English keyword is often a term nobody types.

Run commands as `npx @appeeky/spec <command> --json`.

## 1. Pick the storefront and the locale

- Storefronts are countries (`us`, `de`, `tr`). Listing locales are languages (`en-US`, `de-DE`, `tr`). One storefront can read several locales.
- Run `coverage --json`: `crossLocalization` shows extra locales a storefront already reads and how many keyword characters they leave unused. Filling those is the cheapest win (for the US App Store: the `es-MX` keyword field).
- For a new market, ask the user which countries matter (downloads, revenue, plans) before writing many locales.

## 2. Targets first

Add the market's targets to `appeeky.spec.yaml` before writing copy:

```yaml
targets:
  de: [einschlafgeräusche, weißes rauschen, regengeräusche]
```

Find the terms locally: what competitors in that country use in their titles and subtitles, store search suggestions, and keyword popularity from the Appeeky MCP server or `suggest --country <cc> --json` when `APPEEKY_API_KEY` is set. Mark terms you are unsure about and ask a native speaker when one is available.

## 3. Write the listing file

Create `appeeky/store/app-store/<locale>.yaml` or `appeeky/store/google-play/<language>.yaml` (Google Play uses codes like `de-DE`, `tr-TR`).

- Only the fields you write are managed. Start with name, subtitle and keywords (App Store) or title and short description (Google Play); leave descriptions out until they are written properly.
- Keep the brand in the name the same in every locale.
- App Store keyword field: 100 characters, commas without spaces, no words already in the name or subtitle, no plurals of present words. Characters, not bytes.
- Google Play: a new language needs title, short description and full description together.
- For a secondary locale used only for another storefront's keywords (es-MX for the US), fill the keyword field with that storefront's target words that the primary locale does not cover. Name and subtitle should still read correctly in the locale's language.

## 4. Check and ship

1. `check --json` (no errors) and `coverage --country <cc> --json`: the new targets should be covered or partial.
2. `diff --json`: a new locale shows as `newLocale`. On the App Store a new locale needs a version in Prepare for Submission.
3. Push only when the user asks, with a note naming the market and the hypothesis: `push --note "Launch de-DE: einschlafgeräusche, weißes rauschen"`.

## Mistakes to avoid

- Machine-translating the English keyword field.
- Copying the English subtitle into every locale.
- Adding ten locales at once with no targets: nothing can be measured.
- Using another app's brand name as a keyword.
