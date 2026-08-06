# google-ads-baby

Local MCP server and plugin for managing Google Ads accounts with two-phase safety confirmation.

It can list Google Ads accounts and campaigns, run read-only GAQL, prepare budget/status changes, and prepare creation of paused Search campaigns, ad groups, and responsive search ads.

## Safety model

All write operations use a two-step flow:

1. The LLM calls a `prepare_*` tool with a short random `safe_word`.
2. The server returns a preview, one-shot token, expiry, and the safe word.
3. The user must reply with the safe word.
4. Only then can the LLM call `confirm_mutation`.

Claude Code and Codex hooks enforce the user-message gate. The MCP server also keeps mutation tokens server-side, one-shot, and time-limited.

## Requirements

- Node.js 18+
- Google Ads API developer token
- Access to at least one Google Ads manager/client account
- Claude Code or Codex with plugin/MCP support

## Build

```bash
cd server
npm install
npm run build
```

## Install In Claude Code

This repository can be installed as a Claude Code plugin through its marketplace
manifest:

```text
.claude-plugin/plugin.json
.claude-plugin/marketplace.json
```

Add the GitLab repository as a Claude Code plugin marketplace, then install the
plugin:

```bash
/plugin marketplace add https://gitlab.com/treetank/google-ads-baby.git
/plugin install google-ads-baby@google-ads-baby-marketplace
```

After installation, reload or restart Claude Code. The plugin registers:

- MCP server: `google-ads`
- safety hooks from `hooks/hooks.json`

After installing, ask Claude to run:

```text
setup_google_auth
```

To update later, update the marketplace from Claude Code or reinstall the plugin
from the same marketplace.

## Install In Codex

This repository contains Codex plugin metadata:

```text
.codex-plugin/plugin.json
.mcp.json
hooks.json
.agents/plugins/marketplace.json
hooks/google-ads-baby-safety/hooks.json
```

The marketplace entry points to `./plugins/google-ads-baby`. That directory is a small Codex wrapper; it starts the MCP server through `npx` from this GitHub repository, so the installed plugin does not need to carry a local copy of `server/`.

Current Codex builds may not activate plugin-local hooks even when `hooks.json` exists. If Codex shows `No plugin hooks`, install the safety hooks separately:

```bash
npx codex-marketplace add treetank-net/google-ads-baby/hooks/google-ads-baby-safety --hook --global
```

Add this repository as a local Codex plugin/marketplace source, then enable `google-ads-baby`. The MCP server is configured in `.mcp.json` and runs through `npx` so a fresh install can build the server before starting.

## First Setup

Run the MCP tool:

```text
setup_google_auth
```

The tool opens a local browser flow:

1. Log in with Google.
2. Paste your Google Ads developer token.
3. Select the MCC/account from the list.
4. Choose the safety level.
5. Save.

Config is stored locally in:

```text
~/.google-ads-baby/config.json
```

or in the plugin data directory when the client provides one.

## Safety Levels

Safety can be configured during setup or via env vars.

- `standard`: safe word required, 1 hour token/state TTL
- `strict`: safe word required, 5 minute token/state TTL
- `off`: disables the client hook gate; server-side prepare token is still required

Optional env vars:

```text
GOOGLE_ADS_SAFETY_LEVEL
GOOGLE_ADS_BABY_PROFILE
GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS
GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS
GOOGLE_ADS_MAX_DAILY_BUDGET
GOOGLE_ADS_MAX_CPC
GOOGLE_ADS_MAX_TARGET_CPA
```

## Amounts and Account Currency

Every `*_amount` field is in the **account currency** — the plugin never converts. `list_accounts`
shows the currency of each account, and the analysis reports repeat it in a `currency` field.

Safety caps default to 500 / 50 / 500 units on a PLN account and are scaled per currency, so the
cap means roughly the same amount of money everywhere instead of the same number:

| Currency | Daily budget | Max CPC | Target CPA |
| --- | --- | --- | --- |
| PLN | 500 | 50 | 500 |
| EUR, USD, GBP, CHF | 125 | 12.50 | 125 |
| CZK | 2 500 | 250 | 2 500 |
| HUF | 50 000 | 5 000 | 50 000 |
| unknown / unreadable | 500 | 50 | 500 |

An unknown currency falls back to the PLN numbers — the strictest option for weak currencies, on
purpose. Set `GOOGLE_ADS_MAX_DAILY_BUDGET`, `GOOGLE_ADS_MAX_CPC` or `GOOGLE_ADS_MAX_TARGET_CPA`
to a number of account currency units to override a cap outright; an explicit value is used as
given and is not scaled.

The cost thresholds inside the analysis reports (waste floors, zero-spend floors, the low-CPC
floor in the Display diagnostics) are scaled the same way, and the report says so when it happens.

## Geo and Language Targeting

Campaign builders take `locations` and `languages`. Each accepts an **ISO code** or a **numeric
criterion ID**, mixed freely:

```json
{ "locations": ["PL", "CZ"], "languages": ["pl", "cs"] }
{ "locations": ["2616", "1012820"], "languages": ["1030"] }
```

Codes are resolved against the API and cached for the life of the server process. Languages are
checked for `targetable` and a non-targetable one is rejected by name before anything is created;
an unknown code is an error naming what was not found. Previews show resolved labels
(`Poland (PL)`, `Polish (pl)`), not raw IDs.

There is **no default market**. Presets carry match types and bidding only, so a composite builder
called without `locations` and `languages` fails validation rather than guessing a country. Before
0.21.0 the presets hardcoded Poland — with the wrong language ID, which is how this was found.

## Bundled Skill

The plugin ships a `gaql` skill (`skills/gaql/SKILL.md`) for writing queries for `execute_gaql`.
It covers what GAQL does not support (`OR`, grouping parentheses, `JOIN`, `GROUP BY`, aggregate
functions), enums arriving as numbers, micros, how `segments.*` multiplies rows, and a set of
ready-made queries. Claude Code loads it on demand when a task involves GAQL.

## Tool Profiles

`GOOGLE_ADS_BABY_PROFILE` decides which tools the server registers. The full manifest costs
about 21 000 tokens of context in every session, so a narrower profile is worth setting when you
only need part of the plugin. Restart the MCP server after changing it.

| Profile | Tools | Manifest | What it covers |
| --- | --- | --- | --- |
| `full` (default) | 62 | ~21 400 tok | Everything |
| `manage` | 38 | ~10 400 tok | Reads, diagnostics, and edits to existing entities (budget, bids, status, text, targeting, schedules). No creation, assets, cloning or `*_full` builders. |
| `read` | 15 | ~3 800 tok | Reads, the five analysis reports, mutation history, auth. No `prepare_*`/`confirm_*` at all — mutation is impossible, not merely gated. |

Claude Code loads MCP tool schemas on demand, so the saving there is small; Codex, Cursor and
Claude Desktop read the whole manifest up front and benefit fully.

For local end-to-end tests only, `GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1` enables the `confirm_safe_word` fallback. Keep it unset or `0` for normal use so write confirmation goes through client hooks.

## Available Tools

<!-- TOOLS:BEGIN — generated by scripts/generate-readme-tools.mjs; do not edit by hand -->

Setup & maintenance:

- `setup_google_auth` — Start Google OAuth flow
- `update_plugin` — Check for plugin updates and install them

Read:

- `execute_gaql` — Run an arbitrary GAQL query against a Google Ads account (read-only)
- `get_ad_blueprint` — Get one ad with campaign/ad group context, linked assets, and a clone-ready input shape for supported ad types
- `get_build_context` — One-shot read of everything needed to build or extend campaigns on an account: campaigns (id/name/type/status/budget), ad groups (id/name/campaign), enabled conversion actions (needed for conversion-based bidding), and reusable image assets
- `get_campaigns` — Get campaigns with performance metrics for a specific account
- `list_accounts` — List all Google Ads accounts under the MCC
- `list_ads_entities` — List Google Ads entities with optional filters and relationship context

Read-only analysis (review loops — findings + suggested follow-up task + possible `prepare_*` actions; never mutate):

- `get_account_hygiene_report` — Read-only daily-check analysis for one account: scans enabled campaigns over a window and flags zero-spend, low budget utilization, and spend-with-no-conversions per the google-ads-daily-check workflow
- `get_budget_scaling_candidates` — Read-only scan for budget-constrained SEARCH/SHOPPING campaigns: high budget utilization (>= 90%) together with search impression share lost to budget (> 10%), per the google-ads-monthly-review workflow
- `get_display_remarketing_diagnostics` — Read-only delivery diagnostics for Display remarketing campaigns: checks serving status, whether any user list is attached, audience size against the ~100-user Display minimum, Display eligibility and membership duration of each list, paused ad groups inside enabled campaigns, and manual CPC bids low enough to suppress delivery
- `get_pmax_channel_breakdown` — Read-only Performance Max analysis: cost/conversions per asset group with each group's share of its campaign spend, flagging asset groups burning budget with 0 conversions
- `get_search_terms_waste_candidates` — Read-only negative-keyword scan: search terms with cost >= threshold and 0 conversions in the recent window, cross-checked against a longer window so historically-converting terms (bounce-backs) are excluded, per the google-ads-monthly-review workflow

Mutation history:

- `get_mutation_history` — Browse past mutation operations
- `get_mutation_stats` — Get summary statistics of past mutations: total count, success/fail rate, breakdown by action type, which fields were changed for *_update actions, recently used asset IDs

Write preparation — campaigns, budgets, targeting:

- `prepare_ad_group_update` — Prepare an update to an existing ad group (max CPC bid, status, name, optimized targeting)
- `prepare_ad_group` — Prepare creation of a paused Search ad group under an existing campaign
- `prepare_ad_schedule` — Prepare creating ad schedule criteria (dayparting) with optional bid modifiers for a campaign
- `prepare_bidding_strategy` — Prepare changing the bidding strategy of a campaign (e.g. from Manual CPC to Target CPA or Target ROAS)
- `prepare_budget_change` — Prepare a campaign budget change
- `prepare_campaign_conversion_goals` — Prepare updating which conversion goals are primary (biddable) for a campaign
- `prepare_campaign_extensions` — Prepare batch creation of campaign extensions (sitelinks, callouts, call, structured snippets) AND link them to a campaign in one atomic operation
- `prepare_campaign_removal` — Prepare removal of one or more campaigns
- `prepare_campaign_shared_set` — Prepare linking an existing shared set (e.g. negative keyword list) to a campaign
- `prepare_campaign_status` — Prepare a campaign status change (enable/pause)
- `prepare_campaign_targeting` — Prepare adding location and language targeting criteria to a campaign
- `prepare_campaign_update` — Prepare an update to an existing campaign (name, status, daily budget, bidding strategy)
- `prepare_demographic_bid_modifier` — Prepare setting bid modifiers for demographic criteria (age range / gender) on a campaign or ad group
- `prepare_display_ad_group` — Prepare creation of a paused Display ad group under an existing campaign
- `prepare_display_campaign_full` — Prepare a COMPLETE Display campaign in ONE atomic operation: budget + campaign + bidding + geo/language targeting + ad group + one responsive display ad (using existing uploaded image asset IDs)
- `prepare_display_campaign` — Prepare creation of a paused Display campaign with a daily budget
- `prepare_negative_topics` — Prepare creation of negative topic criteria at campaign level (excludes content categories from delivery)
- `prepare_performance_max_campaign_full` — Prepare a COMPLETE Performance Max campaign in ONE atomic operation: budget + campaign (AI asset enhancements OFF by default) + asset group + inline text assets (headlines/long headlines/descriptions/business name) + linked existing image assets + optional audience signals
- `prepare_performance_max_campaign` — Prepare creation of a paused Performance Max campaign with a daily budget
- `prepare_remove_ad_group_criterion` — Prepare removal of ad group criteria (e.g. display topics, placements, audiences) by full resource name
- `prepare_search_campaign_full` — Prepare a COMPLETE Search campaign in ONE atomic operation: budget + campaign + bidding + geo/language targeting + ad groups (each with keywords and a responsive search ad) + extensions (sitelinks/callouts/call)
- `prepare_search_campaign` — Prepare creation of a paused Search campaign with a daily budget

Write preparation — ads & keywords:

- `prepare_ad_status` — Prepare status change (enable/pause) for an existing ad
- `prepare_ad_update` — Prepare an update to an existing responsive search or responsive display ad (status, final URL, headlines, descriptions)
- `prepare_clone_entity` — Prepare cloning a supported Google Ads entity as paused
- `prepare_keyword_status` — Prepare status change (enable/pause/remove) for existing keywords in an ad group
- `prepare_keywords` — Prepare creation of enabled search keywords in an existing ad group
- `prepare_negative_keywords` — Prepare creation of negative keywords at campaign or ad group level
- `prepare_responsive_display_ad` — Prepare creation of a paused responsive display ad under an existing ad group
- `prepare_responsive_search_ad` — Prepare creation of a paused responsive search ad under an existing ad group

Write preparation — assets & extensions:

- `prepare_ad_group_assets` — Prepare linking existing assets (images, sitelinks, callouts, etc.) to an ad group
- `prepare_asset_group_assets` — Prepare linking existing assets to a Performance Max asset group
- `prepare_asset_group_listing_groups` — Prepare creation of Performance Max asset group listing group trees
- `prepare_asset_group_signals` — Prepare linking asset group signals to a Performance Max asset group
- `prepare_asset_group` — Prepare creation of a paused Performance Max asset group under an existing campaign
- `prepare_call_asset` — Prepare creation of a call (phone) asset for click-to-call extensions
- `prepare_callout_assets` — Prepare creation of callout assets (short USP phrases like "Free shipping", "24/7 support")
- `prepare_campaign_assets` — Prepare linking existing assets (images, sitelinks, callouts, etc.) to a campaign
- `prepare_image_asset_from_file` — Prepare upload of an image asset from a local file path
- `prepare_image_asset_from_url` — Prepare upload of an image asset from a public URL
- `prepare_sitelink_assets` — Prepare creation of sitelink assets
- `prepare_structured_snippet_assets` — Prepare creation of structured snippet assets (e.g. header "Types" with values "Sedan, SUV, Truck")

Confirmation & safety:

- `confirm_all_mutations` — Execute ALL pending mutations in one batch
- `confirm_mutation` — Execute a previously prepared mutation
- `confirm_safe_word` — Test-only fallback for confirming a safe word when GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1
- `get_safety_setup` — Explain the current mutation safety model and how to install Codex hooks if plugin-local hooks are not active
- `list_pending_mutations` — List all pending (unconfirmed) mutations with their previews and tokens

<!-- TOOLS:END -->

Regenerate this list after adding or renaming tools:
`node scripts/generate-readme-tools.mjs`.

## Common Workflows

**A/B test a new ad.** New RSAs are always created PAUSED by design. Create it
(`prepare_responsive_search_ad` → confirm), review it in context
(`get_ad_blueprint`), then enable it (`prepare_ad_status` → confirm). Both
mutations can share one safe word and one user confirmation via
`confirm_all_mutations` when prepared in the same turn.

**Demographic bid adjustments.** Pull criterion IDs first
(`execute_gaql` on `ad_group_criterion` / `campaign_criterion` for age/gender),
then `prepare_demographic_bid_modifier` — works on campaign or ad group level,
`0.0` excludes the segment entirely.

**Dayparting.** `prepare_ad_schedule` with per-day/hour entries and optional
bid modifiers (e.g. lower bids on Sundays when CPA runs high).

**Review loop.** `get_account_hygiene_report` / `get_budget_scaling_candidates`
/ `get_search_terms_waste_candidates` / `get_pmax_channel_breakdown` return
findings with severity, a suggested follow-up task (store it via `append_task`
in the `marketing-context` plugin), and ready-to-run `prepare_*` actions. Pair
with `report-baby` to render client-facing PDF summaries.

## OAuth Credentials

The plugin includes OAuth app credentials for the local desktop setup flow. They are application credentials, not user credentials. User refresh tokens and Google Ads config are saved only locally.

You can override the bundled OAuth app with:

```text
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
```

## Development

```bash
cd server
npm run build
npm start
```

For MCP Inspector:

```bash
cd server
npx @modelcontextprotocol/inspector node dist/index.js
```

Use `setup_google_auth` inside the inspector after connecting.
