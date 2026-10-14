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

`GOOGLE_ADS_BABY_PROFILE` decides which tools the server registers. The default is `read`:
analysis is the common case, and the narrower manifest is cheaper in every session. Set `manage`
or `full` to change accounts, then restart the MCP server. An unknown value falls back to `read`.

| Profile | Tools | Manifest | What it covers |
| --- | --- | --- | --- |
| `read` (default) | 15 | ~2 100 tok | Reads, the five analysis reports, mutation history, auth. No `prepare_*`/`confirm_*` at all — mutation is impossible, not merely gated. |
| `manage` | 41 | ~5 800 tok | Reads, diagnostics, and edits to existing entities (budget, bids, status, text, targeting, schedules). No creation, assets, cloning or `*_full` builders. |
| `full` | 65 | ~12 100 tok | Everything |

Claude Code loads MCP tool schemas on demand, so the saving there is small; Codex, Cursor and
Claude Desktop read the whole manifest up front and benefit fully.

For local end-to-end tests only, `GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1` enables the `confirm_safe_word` fallback. Keep it unset or `0` for normal use so write confirmation goes through client hooks.

## Available Tools

<!-- TOOLS:BEGIN — generated by scripts/generate-readme-tools.mjs; do not edit by hand -->

Setup & maintenance:

- `setup_google_auth` — Start Google OAuth; returns a URL for the user
- `update_plugin` — Check for and download plugin updates

Read:

- `execute_gaql` — Run a read-only GAQL query
- `get_ad_blueprint` — One ad with its context, linked assets and a clone-ready input
- `get_build_context` — One call before building: campaigns, ad groups, enabled conversion actions, reusable image assets
- `get_campaigns` — Campaigns with performance metrics, including zero-activity ones (REMOVED excluded)
- `list_accounts` — List accessible Google Ads accounts with their currency
- `list_ads_entities` — List campaigns, ad groups, ads, keywords, negatives, assets or ad-asset links, with filters

Read-only analysis (review loops — findings + suggested follow-up task + possible `prepare_*` actions; never mutate):

- `get_account_hygiene_report` — Daily check: zero spend, low budget use, spend without conversions
- `get_budget_scaling_candidates` — Budget-limited SEARCH/SHOPPING campaigns worth scaling, with prepare_budget_change actions.search impression share lost to budget (> 10%), per the google-ads-monthly-review workflow
- `get_display_remarketing_diagnostics` — Why a Display remarketing campaign is not serving: status, lists, audience size, bids
- `get_pmax_channel_breakdown` — Performance Max cost and conversions per asset group, flagging spend without conversions
- `get_search_terms_waste_candidates` — Search terms with spend and 0 conversions (bounce-backs excluded) as negative-keyword candidates.cross-checked against a longer window so historically-converting terms (bounce-backs) are excluded, per the google-ads-monthly-review workflow

Mutation history:

- `get_mutation_history` — Past mutations from the local audit log
- `get_mutation_stats` — Summary of past mutations: counts, success rate, per action, recent asset IDs

Write preparation — campaigns, budgets, targeting:

- `prepare_ad_group_update` — Update ad group CPC, status, name or optimized targeting; preview shows before -> after
- `prepare_ad_group` — Create a paused Search ad group
- `prepare_ad_schedule` — Add ad schedules (dayparting) with optional bid modifiers
- `prepare_bidding_strategy` — Change a campaign's bidding strategy
- `prepare_budget_change` — Change a campaign budget; the preview reads the current amount and flags shared budgets
- `prepare_campaign_conversion_goals` — Choose which conversion goals are primary (biddable) for a campaign
- `prepare_campaign_extensions` — Create sitelinks, callouts, call and snippets and link them, plus existing assets, in one confirm
- `prepare_campaign_removal` — Remove campaigns
- `prepare_campaign_shared_set` — Link a shared set, e.g. a negative keyword list, to a campaign
- `prepare_campaign_status` — Enable or pause a campaign
- `prepare_campaign_targeting` — Add location and language targeting to a campaign
- `prepare_campaign_update` — Update campaign name, status, daily budget or bidding; preview shows before -> after
- `prepare_demographic_bid_modifier` — Set age/gender bid modifiers on a campaign or ad group
- `prepare_display_ad_group` — Create a paused Display ad group
- `prepare_display_campaign_full` — Create a whole Display campaign in one confirm: budget, bidding, targeting, ad group, responsive display ad from existing images
- `prepare_display_campaign` — Create an empty paused Display campaign
- `prepare_negative_topics` — Exclude topics at campaign level
- `prepare_performance_max_campaign_full` — Create a whole asset-based Performance Max campaign in one confirm: budget, asset group, text and existing image assets, signals
- `prepare_performance_max_campaign` — Create an empty paused Performance Max campaign
- `prepare_remove_ad_group_criterion` — Remove ad group criteria (topics, placements, audiences)
- `prepare_search_campaign_full` — Create a whole Search campaign in one atomic confirm: budget, bidding, targeting, ad groups with keywords and RSAs, extensions
- `prepare_search_campaign` — Create an empty paused Search campaign

Write preparation — ads & keywords:

- `prepare_ad_status` — Enable or pause an ad
- `prepare_ad_update` — Update an RSA or RDA's status, URL, headlines or descriptions; preview shows before -> after
- `prepare_clone_entity` — Clone a responsive search or display ad as paused, optionally replacing text, URL or images
- `prepare_keyword_status` — Enable, pause or remove keywords
- `prepare_keywords` — Add keywords to a Search ad group
- `prepare_negative_keywords` — Add negative keywords at campaign or ad group level
- `prepare_responsive_display_ad` — Create a paused responsive display ad
- `prepare_responsive_search_ad` — Create a paused responsive search ad

Write preparation — assets & extensions:

- `prepare_ad_group_assets` — Link existing assets to an ad group
- `prepare_asset_group_assets` — Link existing assets to a Performance Max asset group
- `prepare_asset_group_listing_groups` — Create a Performance Max listing group tree
- `prepare_asset_group_signals` — Add search-theme or audience signals to a Performance Max asset group
- `prepare_asset_group` — Create a paused Performance Max asset group with its core assets
- `prepare_call_asset` — Create a call asset; link it with prepare_campaign_assets (CALL)
- `prepare_callout_assets` — Create callout assets; link them with prepare_campaign_assets (CALLOUT)
- `prepare_campaign_assets` — Link existing assets to a campaign
- `prepare_image_asset_from_file` — Upload an image asset from a local file
- `prepare_image_asset_from_url` — Upload an image asset from a public URL
- `prepare_sitelink_assets` — Create sitelink assets; link them with prepare_campaign_assets (SITELINK)
- `prepare_structured_snippet_assets` — Create structured snippet assets; link them with prepare_campaign_assets (STRUCTURED_SNIPPET)

Confirmation & safety:

- `confirm_all_mutations` — Execute several prepared mutations that share one confirmed safe word
- `confirm_mutation` — Execute a prepared mutation or batch after the user replied with its safe word
- `confirm_safe_word` — Test-only: confirm a safe word when GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1
- `discard_pending_mutations` — Drop pending operations without executing them
- `get_safety_setup` — Explain the mutation safety model and hook installation
- `list_pending_mutations` — List pending (unconfirmed) mutations
- `prepare_batch` — Fold pending tokens into one batch: one preview, one new server-generated safe word
- `unfold_batch` — Split a batch back into separate pending operations

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
