---
name: appeeky-spec-experiments
description: Run and measure growth experiments outside the store listing in an Appeeky Spec repo, such as screenshots, UGC and creator videos, ads and pricing, with install attribution, smart links and the app's numbers. Use when asked to test screenshots, a TikTok or creator campaign, an ad creative or a price, to set up attribution, to see where installs and revenue come from, or to pull analytics, ads and RevenueCat data for analysis.
metadata:
  version: 1.0.0
---

# Experiments, attribution and data with Appeeky Spec

A listing push is already an experiment: `verify` measures it. Everything else you try to grow the app, like a new screenshot set, a creator video, an ad or a price, is tracked the same way in `appeeky/experiments/<id>.yaml`. Each one has one hypothesis, one metric, a baseline, a date to check and a result.

Run commands as `npx @appeeky/spec <command> --json`.

## 1. Know what can be measured

`experiment add --metric` takes one metric. Prefer one the spec can measure on its own. It then takes the baseline from the last days and `verify` closes the experiment when it is due:

| Needs | Metrics |
| --- | --- |
| `APPEEKY_API_KEY` with the store connected in Appeeky | `conversion`, `page_views`, `downloads`, `proceeds`, `trials` |
| RevenueCat connected in Appeeky (app-scoped project) | `revenue`, `rc_trials`, `trial_conversion` |
| Apple Search Ads connected in Appeeky, or `search-ads pull` | `ad_installs`, `cpa` |
| Meta / TikTok campaigns under `ads:` | `meta_spend`, `meta_installs`, `meta_cpi`, `tiktok_spend`, `tiktok_conversions`, `tiktok_cpa` |
| `attribution:` in the spec | `organic_installs`, `organic_revenue`, `organic_paid`, and with `--link`: `link_clicks`, `link_installs`, `link_revenue` |
| reviews pulled | `rating`, `low_ratings` |
| AI Visibility / `category pull` | `ai_visibility`, `category_rank` (see appeeky-spec-visibility) |

Without any of these, the user gives the value at the end (`experiment close --value`). Say so up front.

## 2. Attribution: where installs come from

With Appeeky Analytics in the app, the spec knows each install's source: organic store search, an Apple Search Ads keyword, a smart link, the Google Play referrer. It also knows what that install paid. Set it up once:

- `attribution init` uses Appeeky's hosted service (`APPEEKY_API_KEY`). `attribution init --self <url>` uses the user's own server on Cloudflare (`ATTRIBUTION_TOKEN`).
- It writes `attribution:` to the spec and prints the SDK key and the RevenueCat webhook. Adding the SDK to the app and the webhook to RevenueCat is a code and settings change: propose it, do not do it silently.
- An app on both stores has one id per store under `attribution.app`.

Then listing releases are judged on organic installs and revenue first, not only ranks.

## 3. Start an experiment

```bash
npx @appeeky/spec experiment add --type ugc --persona new-parents \
  --hypothesis "A 'my baby slept in 5 minutes' hook gets more installs per view than the product demo" \
  --metric link_installs --days 14 --link tiktok
```

- `--type`: `screenshots`, `ugc`, `ads`, `pricing`, `other`.
- `--persona`: an id from `personas` in the spec. Write the hypothesis for that person.
- `--link [channel]` creates a smart link for the experiment (needs `attribution:`), so its installs and revenue are counted exactly. Channels: `tiktok`, `instagram`, `creator`, `tiktok_ads`, `meta_ads`, and others. Give each creator or ad its own experiment and link.
  - **App Store caveat:** link installs can only be counted on Google Play. For an App Store-only app, measure `link_clicks`.
- `--asset` records what ran: file paths, video links, ad ids.
- `--baseline` and `--target` when the user knows them. Otherwise the baseline is measured.

Rules:

- One change per experiment. A new video with a new price measures neither.
- Do not start a screenshot or pricing experiment on a store that has a listing release still being measured. Check `status` first; `free` stores are safe. Both would move conversion.
- Screenshots are not indexed for search. They change conversion, so measure `conversion` (or `organic_installs` with attribution).

## 4. Close it

`verify` closes due experiments on measured metrics (`closedExperiments` in its JSON) and lists the ones that still need a value (`dueExperiments`). For those:

```bash
npx @appeeky/spec experiment close <id> --value 3.1 --note "Hook B: 3.1 installs per 1k views vs 1.8" --playbook
```

`--playbook` adds the result to `appeeky/playbook.md`. A lost experiment is a result too: write it so it is not tried again.

## 5. Ads

- `ads --json` gives spend, installs and cost per install for the last `--days` (default 30). It covers Apple Search Ads and the Meta and TikTok campaigns listed under `ads:` in the spec.
- With the user's own Search Ads key, `search-ads pull` writes `appeeky/search-ads/`: `daily.csv`, `keywords.csv`, `search-terms.csv` and `summary.md`. The key is saved on the App Store Connect CLI account (`appstore accounts search-ads <account> --client-id … --team-id … --key-id … --private-key-path …`, the account in `stores.appStore.account`), or set as `ASA_*` env in CI. It reads only the campaigns for the App Store app (`stores.appStore.searchAds` sets the org and the campaigns). The summary lists search terms that installed and are not targets yet: propose them as targets, since ranking for them organically is free. `ads` and `verify` then read Search Ads from these files, without Appeeky.
- `--save` keeps a copy in `appeeky/ads/<date>.yaml`.
- Campaigns are listed by id. Ask the user which campaigns promote this app; never guess from names.

## 6. Social posts and UGC videos

With accounts and creator personas set up in Appeeky (`APPEEKY_API_KEY`):

- `social pull` writes the connected accounts, the posts made through Appeeky and in each platform's app, how each did, comments and followers to `appeeky/social/` (read `summary.md`). `ugc pull` writes the personas (`ready` when they can make clips) and their clips to `appeeky/ugc/`.
- To post: write `appeeky/social/drafts/<date>-<slug>.yaml` (`accounts`, `text`, `when`, `media`, `tiktok`, `youtube`, `why`) and run `social check`. YouTube needs exactly one video; Threads (500), Bluesky (300) and Facebook take text alone. Name accounts by handle (`tiktok:@handle`) when a platform has more than one. To make a video: write `appeeky/ugc/briefs/<date>-<slug>.yaml` (`persona`, `script`, `scene`, `caption`, `durationSec`, `aspectRatio`, `why`) and run `ugc generate --dry-run` for its cost.
- Open a pull request. `social push` and `ugc generate` run after the merge (the push workflow does it). Never run them, or `ugc generate --yes`, unless the user asked: posts are public and clips use media credits.
- Comments: `social comments --unanswered --json` lists the ones to answer. Draft each reply as a `social reply <id> "<message>"` command within the platform's reply limit and show it to the user; run `social reply`, `hide`, `like` or `delete-comment` only when the user asked for that comment.
- Give each post or video its own smart link (`experiment add --link <channel>`) so `experiment close` can say what it brought.

## 7. Data for analysis

`data pull --json` writes CSV files the agent can read: store analytics, traffic sources, sales, Apple Search Ads, RevenueCat, Meta and TikTok per day. It also writes attribution by source, keyword and smart link. `--days` defaults to 90, and `README.md` in the folder says what each file holds.

- They are private business numbers. They go to `.appeeky/data/` (gitignored) unless the spec says `data: { commit: true }`. Never move them into the repo or paste them into a public pull request without asking.
- Pulling again merges by date, so files grow; there is no need to delete them first.
- Use them to find the next experiment: a country with many page views and low conversion, a channel with rising cost per install, a keyword that brings installs that never pay.
