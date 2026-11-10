# Changelog

## 0.3.0 (2026-11-10)

### Features

- guided init makes the app's folder, shows progress and hands over to your coding agent (#3) ([6e9885e](https://github.com/appeeky/appeeky-spec/commit/6e9885e891e238ee6906b83ddf6f4753166b284f))

## 0.2.1 (2026-11-08)

### Fixes

- close link experiments in verify, send review replies on merge, keep the Search Ads currency, report screenshot errors (#2) ([b8b35c7](https://github.com/appeeky/appeeky-spec/commit/b8b35c7e8b1bbc9794b21727da7cbb29e9d6fe03))

## 0.2.0 (2026-11-08)

- `search-ads pull`: Apple Search Ads on your own API key, no Appeeky account. The key lives on your App Store Connect CLI account next to the App Store Connect key (`appstore accounts search-ads`), and Spec calls Apple through `appstore search-ads call`; in CI, `ASA_CLIENT_ID`, `ASA_TEAM_ID`, `ASA_KEY_ID` and `ASA_PRIVATE_KEY` work instead. Reads the campaigns for the App Store app (`stores.appStore.searchAds` picks the org and campaigns) and writes spend, installs, taps and impressions per day, keywords, search terms and `summary.md` (search terms that installed and are not targets, keywords that spent and brought nothing) to `appeeky/search-ads/`. `ads` and `verify` read it. The daily routines pull it when the key is set.
- `seo pull` also works with a gcloud application-default login on your own machine.
- `seo ranks|keywords|domain` on your own DataForSEO account (`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`). `ranks` records the site's Google position, the app's store page position on Google and Google AI Overview citations per keyword to `appeeky/seo/ranks.csv` and `ranks.md`, with what moved in `changes.md`; `keywords` writes volume, difficulty, CPC, intent and related ideas; `domain` writes what the site ranks for and the competing sites. `web.keywords`, `web.countries` and `web.device` pick what to watch. `verify` measures `web_rank` and `ai_overview_citations`. The daily routines check ranks every `SEO_RANKS_EVERY` days (7); the weekly agent cannot run the paid ones.

- `visibility init --local` and `visibility scan --local`: AI visibility on your own keys, no Appeeky account. Any of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `PERPLEXITY_API_KEY` adds that assistant; prompts are asked with web search on, the apps named are extracted by a second cheap call, and the result is the same `appeeky/visibility/<country>.yaml`, plus `history.csv` and `answers/<country>.jsonl`. `--dry-run` quotes in USD, `--every <days>` skips a storefront scanned recently, `aiVisibility.models` picks the assistants and `aiVisibility.aliases` adds names. `verify` reads `ai_visibility` from `history.csv`. The daily routines scan every `VISIBILITY_EVERY` days when it is set; the weekly routines deny paid scans to the agent.
- `seo check|llms|pull` and `web:` in the spec. `check` reads the app's website like a crawler and lists what is missing for Google, for the app (store links, Smart App Banner, app structured data) and for AI assistants (AI crawlers in robots.txt, llms.txt, text without JavaScript, target keywords, FAQ). `llms` writes llms.txt from the listing. `pull` writes Google Search Console clicks, impressions, queries and pages to `appeeky/seo/` with your own service account (`GSC_CREDENTIALS`); `verify` measures `search_clicks` and `search_impressions`. The daily routines pull it when the credentials are set.

- `report` (and the pull request Action) lists the social posts and UGC clips a merge sends out, with what would fail, next to the listing change.
- `social pull|check|push`: organic social media through the accounts connected in Appeeky. `pull` writes the accounts, recent posts with views, likes, comments and shares, and `summary.md` to `appeeky/social/`; drafts in `appeeky/social/drafts/` are checked and sent after a merge, then marked `sent`.
- `ugc pull|generate`: UGC from Appeeky creator personas. `pull` writes the personas (and whether each can make clips) and their clips to `appeeky/ugc/`; `generate` makes a clip from each brief in `appeeky/ugc/briefs/`, with `--dry-run` for the cost in media credits.
- `ugc generate --local`: render clips where Spec runs with your own `FAL_KEY` (fal bills you, no Appeeky credits), with Appeeky's UGC pipeline bundled into Spec. Personas come from Appeeky or from `appeeky/ugc/personas/<name>.yaml` with their look images; `--dry-run` quotes in USD; the clip lands in `.appeeky/media/` and the brief records its `videoUrl` and cost. The push workflow and docker `push` use it when `FAL_KEY` is set.
- The co-founder review writes the social and UGC specialists' proposals as drafts and briefs in the pull request. The push workflow and the docker `push` routine send them after the merge; the daily routines pull social and UGC; the weekly routines deny publishing and spending commands to the agent.
- Specialist subagents and the co-founder review. `agents install` writes six read-only specialists (`appeeky-aso`, `appeeky-reviews`, `appeeky-ads`, `appeeky-releases`, `appeeky-ugc`, `appeeky-social`) and the `/appeeky-cofounder` command into `.claude/` (`--for opencode` or `all`). The review starts the specialists in parallel, picks one listing change for a free store, writes a brief to `appeeky/briefs/<date>.md` and the pull request text. The guided `init` offers them and `doctor` checks for them. The weekly routines (GitHub Actions, cron, docker `weekly`) run the review, use the installed command when there is no `.github/appeeky-propose.md`, and open a pull request with the brief even when no store is free.
- `visibility init|sync|pull|scan`: AI visibility in the repo. Intents and prompts live under `aiVisibility:` in the spec and sync to Appeeky AI Visibility. `pull` writes whether ChatGPT, Claude, Gemini and Perplexity name the app, who they name instead, the pages they cite and suggested fixes to `appeeky/visibility/<country>.yaml`, with what moved in `changes.md`. `verify` measures `ai_visibility` before and after a push.
- `category pull`: the rank in the category chart (top 100), one row a day in `appeeky/category.csv`. The App Store reads Apple's charts with no key, and the genre and chart come from the app. Google Play goes through the Appeeky API (`category.googlePlay`). `verify` measures `category_rank`, and when no target moved and there is no analytics data, it decides the release.
- Agent skills: `appeeky-spec-visibility` (AI visibility and category rank) and `appeeky-spec-experiments` (experiments, attribution, smart links, ads, data). `appeeky-spec` covers guided `init`, `doctor`, the three workflows and running without GitHub Actions, the weekly routine, `competitors discover` and `report`. `appeeky-spec-review` reads `ai_visibility` and `category_rank`.
- The daily workflow written by `init --ci` runs `category pull` and `visibility pull` before `verify`.
- `docker/`: run the daily, push and weekly routines outside GitHub Actions. `docker compose up -d` on your own server runs them on a schedule (`schedule` mode, with an optional health-check ping); `daily`, `push` and `weekly` run one routine for a scheduler you already have. `push` tracks the last handled commit as a tag, only pushes listing changes merged after its first run, and has `PUSH_DRY_RUN=1`. Each release publishes `ghcr.io/appeeky/appeeky-spec` (and `-agent` with Claude Code and `gh`).

- License: from this release Appeeky Spec is FSL-1.1-MIT (Functional Source License). Use and change it freely for your own apps, including commercially; offering it as a competing product is not allowed.

- `init` offers to save your own App Store Connect key and Google Play service account with the store CLIs (`appstore accounts add`, `gps accounts add`); `doctor` sees saved accounts.
- Fix: a Google Play account in the spec was passed to `gps` as `--profile`; it is `--account` (`stores.googlePlay.account`, `profile` still read).

- `init` with no options is a guided setup: finds the app on the App Store, checks the Google Play package, pulls each store it can reach, suggests targets from current ranks, writes the GitHub workflows (`--ci`, also on an existing spec), offers the agent skills and shows the first coverage. It adds `.appeeky/` to `.gitignore`.
- `doctor`: Node, the spec, store access (local CLI, keys or hosted), pulled listings, targets, the control group, the Appeeky key, attribution, workflows, agent skills and `.gitignore`, each with how to fix it. Exits 1 when something must be fixed.

- `examples/sleep-sounds` is a spec repo two months in: releases with checks and a control group, experiments, the playbook, competitor changes, a reviews summary and `loops.md`.

- `attribution init` (`--self <url>` for your own server): creates or finds the app per store, writes `attribution:`, and prints the SDK key and the RevenueCat webhook.

- `reviews pull`: `summary.md` lists the words and phrases users use in three or more reviews that no listing has.

- `status --json` lists the stores that are `free`: no release being measured there. `examples/weekly/` has a weekly agent proposal (GitHub Actions workflow, prompt, cron script) that only proposes for free stores and opens a pull request.

- `competitors pull` records what each competitor changed since the last pull in `appeeky/competitors/changes.md`, and `status` warns open releases about changes inside their window.

- `verify` compares the storefronts a release changed with the ones it did not (a control group): a lift the whole store shared turns "won" into "mixed", and the check records `control` (each group's move and the net).
- `verify` learns from the four windows before a push how much each metric moves on its own; a change inside that range is flat (`noise` on each change).

- `status` and `appeeky/loops.md`: every release and experiment being measured in one list, with the metric that decides it, the next check and the result so far. Late checks, releases measured over the same days and results on too few installs are flagged. `push`, `verify` and `experiment add|close` keep the file current.

- `verify`: when no target moved, or a release has no targets, organic installs and revenue (with `attribution:`), else conversion, else downloads decide won or lost; the check records `decidedBy`.
- `attribution.app` takes one id per store (`app-store`, `google-play`): each release is measured with its own store's app, `data pull` writes files per store, and experiment links go on the Google Play app, where installs can be counted.
- `link_clicks` metric for experiment links. `experiment add --link` warns that link installs are, in practice, Google Play installs, and suggests `link_clicks` for App Store only apps.
- `data pull`: campaigns no longer collapse into one row; Search Ads keywords are written as `keywordId`; the countries file is `attribution-countries.csv`.

- `attribution:` in the spec reads Appeeky Analytics, self-hosted on Cloudflare (`via: self`, ATTRIBUTION_TOKEN) or hosted (`via: hosted`, APPEEKY_API_KEY). `verify` compares organic installs, their revenue and the share that paid around each push; `data pull` writes attribution by source, keyword, campaign, country and smart link; `experiment add --link` creates a smart link and `experiment close` reads its installs or revenue.
- `reviews pull|list|reply|push`: customer reviews from both stores in `appeeky/reviews/` with `summary.md`; replies drafted in `appeeky/reviews/replies/`, reviewed in a pull request, sent by `reviews push`. `verify` compares the average rating and the share of 1–2 star reviews around each push.
- `competitors discover|pull`: competitors under `competitors:` in the spec, written to `appeeky/competitors/` with their listing, ranks, where they rank for your targets and their recent low ratings.
- `data pull`: App Store Connect, Google Play, Apple Search Ads, RevenueCat, Meta and TikTok numbers per day as CSV in `.appeeky/data/` (or `appeeky/data/` with `data.commit`).
- Meta and TikTok campaigns under `ads:` in `appeeky.spec.yaml`: spend, installs and cost per install (conversions for TikTok) in `verify`, experiments and the new `ads` command. `ads --save` keeps a copy in `appeeky/ads/<date>.yaml`.
- `verify` with `APPEEKY_API_KEY`: conversion, page views, downloads, proceeds and trials (App Store Connect, Google Play), revenue, trials and trial conversion (RevenueCat), and ad installs and cost per install (Apple Search Ads), compared before and after each push and written to the release and the playbook.
- Experiments on those metrics measure their own baseline (`experiment add`) and result (`verify`, `experiment close`); without a target they are judged against the baseline.
- `appeekyMetricSource`, `summarizeMetrics` and `compareWindows` in the library.

## 0.1.0

- `verify`: ranks recorded at push time, checked on day 7 and day 14, verdict in the release and the playbook.
- `suggest`, cross-localization tips in `coverage`, competitor gaps in the library.
- `push --create-version`, `log --markdown`, `report` and a GitHub Action for pull requests.
- `experiment add|list|close`, personas in the spec.
- `screenshots pull|check`.
- Agent skills: `appeeky-spec`, `appeeky-spec-localize`, `appeeky-spec-review`.

- `appeeky.spec.yaml` and `appeeky/store/` for App Store and Google Play listings.
- `init`, `pull`, `check`, `coverage`, `diff`, `push`, `log` and `revert`.
- Local store CLIs or Appeeky's hosted gateways, chosen per store.
- Keyword popularity from the Appeeky API in `coverage`.
- `@appeeky/spec/core`: browser-safe lint, coverage and diff.
