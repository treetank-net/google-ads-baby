---
name: google-ads-manual
description: Reference manual for the google-ads-baby MCP tools - what each analysis tool checks and its thresholds, how the composite *_full builders, update tools, asset linking and mutation batching behave, and which tool fits a task. Use when a tool's one-line description is not enough, when choosing between tools, or when interpreting a finding.
---

# google-ads-baby tool manual

Tool descriptions are intentionally one line long. This page holds the rest.
Amounts are always in the account currency (see `list_accounts`). Thresholds
written in currency units below are PLN-scale defaults, which the server scales
for other currencies, so the same number means a similar amount of money on a
EUR or HUF account.

## Reading the account

| Task | Tool |
|---|---|
| Accounts and their currency | `list_accounts` |
| Campaign performance | `get_campaigns`: every non-REMOVED campaign, including zero-activity ones, sorted by cost (7 or 30 days) |
| Structure without metrics | `list_ads_entities`: campaigns, ad_groups, ads, keywords, negative_keywords, assets, ad_asset_links |
| Anything else | `execute_gaql` (load the `gaql` skill first) |
| Before building ads | `get_build_context`: campaigns, ad groups, enabled conversion actions and reusable image assets in one call |
| One ad in full, ready to clone | `get_ad_blueprint` |

`list_ads_entities` notes:
- `negative_keywords` returns campaign-level negatives. With `ad_group_id` it returns that ad group's negatives instead.
- `type` filters the channel, ad or asset type. For keywords it filters the match type (EXACT, PHRASE, BROAD).
- `status` takes TRUE or FALSE for `ad_asset_links`.
- `limit` caps the API fetch (default 2000, max 5000). Display is paged separately.

`execute_gaql` with `format: json` returns raw rows that are several times
larger than TSV. Use it only when you need nested structures that TSV flattens
badly.

## Analysis tools (read-only, return findings)

Each finding carries a severity, metrics, a suggested follow-up task and
ready-to-use `prepare_*` actions. These tools never mutate anything.

### get_account_hygiene_report (daily check)
Window: 7, 14 or 30 days. It scans enabled campaigns and flags:
- **Zero spend**: daily budget ≥ 30 and spend ≤ 1.
- **Low budget utilization**: below 20%, ignoring budgets under 20.
- **Spend without conversions**: spend ≥ 50 with 0 conversions.

It mirrors the `google-ads-daily-check` workflow in marketing-context.

### get_budget_scaling_candidates (monthly review)
SEARCH and SHOPPING campaigns with budget utilization ≥ 90% **and** more than 10%
of search impression share lost to budget. Reports ROAS, utilization and IS
context, and proposes `prepare_budget_change`.

### get_search_terms_waste_candidates
Search terms with cost ≥ 50 and 0 conversions in `recent_days` (14 or 30).
Each candidate is cross-checked against `cross_check_days` (60 or 90), and a
term that converted in the longer window (a bounce-back) is excluded and listed
separately. It proposes `prepare_negative_keywords`.

### get_pmax_channel_breakdown
Performance Max cost and conversions per asset group, plus each group's share of
its campaign's spend. It flags asset groups with cost ≥ 50 and 0 conversions.
GAQL exposes no clean Shopping/Display/Search split for PMax, so this works at
asset-group level. The feed-only leak check still needs the manual PMax placement
report in the Google Ads UI.

### get_display_remarketing_diagnostics
Use it before touching bids on a Display remarketing campaign that does not
serve. It checks:
- serving status,
- whether any user list is attached,
- list size against the roughly 100-active-user Display minimum,
- Display eligibility of each list, and a membership duration under 7 days,
- paused ad groups inside enabled campaigns,
- manual CPC ≤ 0.10, ignoring budgets under 5.

When the campaign uses automated bidding the report says so, because CPC changes
cannot fix delivery there.

## Building

- **Composite builders.** `prepare_search_campaign_full`,
  `prepare_display_campaign_full` and `prepare_performance_max_campaign_full`
  each create a whole campaign in one atomic API transaction with one
  confirmation. Prefer them over chaining `prepare_search_campaign` +
  `prepare_ad_group` + `prepare_keywords` + ...
- **Search presets** (`preset`):
  - `ecommerce-search`: EXACT + PHRASE, MAXIMIZE_CONVERSION_VALUE.
  - `leadgen-search`: EXACT + PHRASE, MAXIMIZE_CONVERSIONS.
  - `none` or omitted: MANUAL_CPC.

  A keyword without `match_type` expands to EXACT + PHRASE. Campaign negatives
  default to PHRASE. Ad group CPC defaults to 1.00.
- **Market.** `locations` and `languages` have no default. Ask the user, then
  pass ISO codes (`["PL"]`, `["pl"]`) or numeric constant IDs for regions and
  cities. Unknown or non-targetable codes fail before a token is created.
- **Display full** builds the ad from **existing** image assets. Upload them first
  with `prepare_image_asset_from_url` or `prepare_image_asset_from_file`.
  Marketing images are 1.91:1, square images 1:1.
- **PMax full** builds an asset-based campaign: no Merchant feed, no listing
  groups. AI text and URL expansion is opted out by default
  (`opt_out_ai_enhancements: true`).
- **Paused by default.** Everything new is created PAUSED. Ask before enabling.
- **ROAS** is a multiplier everywhere: 4.0 means 400%.

## Changing existing entities

- **Update tools** (`prepare_campaign_update`, `prepare_ad_group_update`,
  `prepare_ad_update`, `prepare_budget_change`) read the current state first, so
  the preview shows real before -> after values. They warn when:
  - a budget is shared by several campaigns,
  - a CPC is set on a campaign whose automated bidding ignores it,
  - an update needs several API calls and so is not atomic.
- **`prepare_ad_update`** replaces the whole headline or description list.
  Pass the full new list, not a diff.
- **Narrow tools** (`prepare_campaign_status`, `prepare_ad_status`,
  `prepare_bidding_strategy`) coexist with the update tools.
- **Demographic modifiers and conversion goals** need IDs from `execute_gaql`
  first: `*_criterion.criterion_id`, or `campaign_conversion_goal` resource names.
  A bid modifier of 0 excludes, 1.0 means no change, 1.5 means +50%.

## Assets and extensions

- **One step.** `prepare_campaign_extensions` creates sitelinks, callouts, a call
  asset and a structured snippet and links them to a campaign in one
  confirmation. It can also link existing image or logo assets.
- **Two steps.** `prepare_sitelink_assets`, `prepare_callout_assets`,
  `prepare_call_asset` or `prepare_structured_snippet_assets` create the assets.
  Then `prepare_campaign_assets` (or `prepare_ad_group_assets`) links them with
  the matching `field_type`: SITELINK, CALLOUT, CALL, STRUCTURED_SNIPPET, or
  AD_IMAGE for image extensions in Search.
- **Structured snippet headers** must be predefined Google values, e.g. Brands,
  Types, Services, Destinations, Courses, Styles, Amenities.
- **PMax asset groups** need their core creatives at creation
  (`prepare_asset_group`). Signals are SEARCH_THEME (text) or AUDIENCE
  (audience_id). Listing group nodes go parent-first, and node 0 is the root
  subdivision.

## Mutation queue

- `prepare_*` never changes the account. It returns a preview and a token.
- **One confirmation for several changes.** Either reuse one safe word across the
  prepares and call `confirm_all_mutations(tokens)`, or call
  `prepare_batch(tokens)`, which yields one combined preview and a new
  server-generated safe word. Then `confirm_mutation(batch token)` runs them in
  order.
- **Fixing one operation in a batch.** Call `unfold_batch`, then
  `discard_pending_mutations` on the wrong token, prepare a corrected one, and
  run `prepare_batch` again.
- **Inspecting and dropping.** `list_pending_mutations` shows the queue.
  `discard_pending_mutations` without tokens clears it, and nothing reaches
  Google Ads.
- **History.** `get_mutation_history` and `get_mutation_stats` read the local
  audit log. Use them to replicate earlier campaigns or reuse asset IDs.
- **Profiles.** `GOOGLE_ADS_BABY_PROFILE=read` registers no mutation tools.
  `manage` allows edits to existing entities. `full` adds creation, assets,
  cloning and the composite builders. Changing the profile requires a server
  restart.
