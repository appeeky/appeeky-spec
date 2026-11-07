---
name: appeeky-spec-review
description: Review what past store listing changes did in an Appeeky Spec repo, decide whether to keep or revert them, update the playbook and plan the next change. Use when asked "did the last listing change work?", "should we revert?", for a weekly ASO review, to close experiments, or to summarize listing releases for a team update or PR.
metadata:
  version: 1.2.0
---

# Review listing releases with Appeeky Spec

Each push in `appeeky/releases/` holds the before/after values, the hypothesis (`note`) and the search ranks from right before it. `verify` measures again on day 7 and day 14.

Run commands as `npx @appeeky/spec <command> --json`.

## 1. Measure

```bash
npx @appeeky/spec verify --playbook --json
```

This only measures releases that reached day 7 or day 14 and have not been measured for that day. Use `verify --now <release-id>` only when the user wants an early look, and say that early ranks are noisy. With `APPEEKY_API_KEY` set, each check also has `metrics`: conversion, downloads, revenue, trials and ads (Apple Search Ads, plus the Meta and TikTok campaigns under `ads:`) before and after the push, each marked `better`, `worse` or `flat`, and due experiments on those metrics are closed for you (`closedExperiments`). The JSON lists experiments that still need a value (`dueExperiments`).

## 2. Read the verdict

| Verdict | Meaning | Usual action |
| --- | --- | --- |
| `won` | More targets rose (3+ places) than fell | Keep. Note what worked in the playbook |
| `lost` | One top-10 target, or two top-20 targets, fell out of the top 20 by 10+ places | Propose `revert` |
| `mixed` | Some rose, as many or more fell | Look at which targets moved and their popularity before deciding |
| `flat` | Nothing moved 3+ places | Wait for day 14; then treat as no effect |

When the check has `control`, read `net`: the places the changed storefronts gained beyond the unchanged ones. A "won" with a small net was turned into "mixed" (see `note`): the whole store moved. A metric change marked flat with a `noise` larger than the change is within its normal week-to-week range; do not credit or blame the release for it.

When no rank moved and the check has `decidedBy`, the verdict came from those outcome metrics, in this order:

1. organic installs and revenue,
2. else conversion,
3. else downloads,
4. else the category rank.

Say so: "won on organic installs, ranks unchanged".

A verdict decided by `category_rank` is the weakest kind. The chart moves with ads, featuring and season too, so say that and prefer waiting for day 14.

Two more metrics can be in `metrics.changes` (see appeeky-spec-visibility):

- `ai_visibility`: the share of AI assistant answers that name the app. Assistants update slowly, so read it on day 14.
- `category_rank`: lower is better, so a negative change is good.

Before recommending, check:

- **Popularity.** One popular term lost can outweigh three tiny ones gained.
- **Conversion and revenue.** When a check has `metrics` (or `conversion`), more ranks with lower conversion or revenue is not a win, and flat ranks with better conversion can be. Lead with the outcome the user cares about: revenue and trials before downloads, downloads before ranks.
- **Other causes.** A new app version, a featuring, a competitor's change (`appeeky/competitors/changes.md`), an ad campaign starting (`ads --json`) or seasonality in the same window. Say when the result could be noise.
- **Day 7 vs day 14.** App Store ranking changes settle over one to two weeks; prefer the day-14 check when it exists.

## 3. Revert when it lost

```bash
npx @appeeky/spec revert <release-id>
npx @appeeky/spec diff --json
```

`revert` only edits the files. Push only when the user agrees, with a note: `push --note "Revert <id>: lost '<keyword>' (<before> → <after>)"`. App Store fields other than promotional text need a new version.

## 4. Close experiments

`verify` closes due experiments on `conversion`, `downloads`, `revenue`, `trial_conversion`, `cpa`, `meta_cpi`, `tiktok_cpa` and the other measured metrics. With `attribution:` in the spec, checks also carry `organic_installs`, `organic_revenue` and `organic_paid`: whether more people found the app in search and paid. For UGC, creator or ad experiments, start them with `--link` so their installs are counted exactly. `appeeky-spec ads --json` shows spend and cost per install per paid channel; `--save` keeps a copy in `appeeky/ads/`. For the rest (installs per 1,000 views, tap-through rate), ask the user for the value or read it from the data they point to, then `experiment close <id> --value <n> --note "..." --playbook`. When starting one, prefer a measured metric: `experiment add --metric trial_conversion` takes its baseline from the last days.

## 5. Update the playbook and plan

`appeeky/playbook.md` gets one line per result from `--playbook`. Add a short "why" in your own words when the cause is clear (for example: "subtitle words beat keyword-field words for 'white noise'"). Then propose the next single change, with a hypothesis that does not repeat a losing one.

## Summaries

`log --markdown -n <count>` prints releases as Markdown tables with the note and the latest verdict, ready for a PR description or a team update.
