# Changelog

## v0.16.1

Everything here was found by running 0.16.0 against a live account. The tools worked;
what they *said* was wrong in ways a reader could not detect.

### Fixed
- **Enum values reached the user as raw numbers.** GAQL returns enums numerically, so `*_update` previews said `Status: 3 → ENABLED` and `Update ad 347658807327 (19)`. They now say `Status: PAUSED → ENABLED` and `(RESPONSIVE_DISPLAY_AD)`.
- **The bidding-strategy warning fired on every CPC change, including when it was false.** It compared a number against the string `'MANUAL_CPC'`, so a campaign actually running MANUAL_CPC was told Google would ignore its bids. The warning now decodes the strategy first, and treats `ENHANCED_CPC` and `PERCENT_CPC` as bid-honouring alongside `MANUAL_CPC`.
- **`get_display_remarketing_diagnostics` had five dead checks.** `campaign_not_serving`, `no_audience_attached`, `zero_impressions`, `ad_group_paused_in_enabled_campaign`, `manual_cpc_below_floor` and `bids_not_the_constraint` all tested enum *names* against numeric values and could never fire on real data — the very checks that tell you a bid change is pointless. The analyzer now accepts both forms.
- **`audience_below_display_minimum` produced one critical finding per (list × campaign) pair** — 71 of them on one account, mostly duplicates, many for paused campaigns. Findings are now emitted once per list, carry the campaigns using it, and are downgraded to `info` when every campaign using the list is paused.
- **A list Google does not size for Display was reported as empty.** Lists with `size_for_display: 0`, a large `size_for_search` and `eligible_for_display: true` are not undersized — Google simply does not populate the Display figure for those list types. That case is now a separate `display_size_not_reported` info finding that says so, instead of a false critical.
- **The diagnostics response reached 97 KB on a 42-campaign account** — large enough to crowd out the context of the model meant to read it. Deduplication, a 40-row cap on the coverage table, and a 25-finding cap across every analysis report (most severe first, so criticals are never the ones dropped) bring the same account down to 42 KB. Both caps say in the response how many rows were dropped, and `summary` still counts every finding.
- **`npm test` deleted the user's Google Ads credentials.** The suite set `CLAUDE_PLUGIN_DATA` while `config.ts` reads `GOOGLE_ADS_BABY_DATA`, so it wrote and then unlinked the real `~/.google-ads-baby/config.json`. It now redirects to a temp directory and aborts outright if the resolved config directory is the real one. If you ran `npm test` on 0.16.0, re-run `setup_google_auth`.
- `prepare_campaign_update` no longer lists API calls it is not going to make ("2 separate calls (campaign, budget, bidding)" now names only the two it makes).

### Verified against a live account
- All five analysis tools and the three `*_update` tools were run against a live 42-campaign Display account (read-only: `prepare_*` previews only, no `confirm_mutation`). The GAQL field names introduced in 0.16.0 — `user_list.size_for_display`, `size_for_search`, `eligible_for_display`, `campaign.serving_status`, `campaign_budget.reference_count` — all exist and return data.
- On that account the fixed diagnostics found what the dead checks had been hiding: three enabled Display campaigns with 115 / 35 / 15 daily budget and zero impressions over 30 days, one with `serving_status: ENDED`, and one remarketing campaign with no user list attached at all. None of those is a bid problem.

### Changed
- Smoke suite is up to 128 assertions. The new ones feed the analyzer **numeric** enums the way GAQL returns them — the old tests passed against the broken code because they only ever used synthetic name strings.

## v0.16.0

### Added
- **`prepare_ad_group_update`** — update an existing ad group: max CPC bid, status, name, optimized targeting. Closes a real gap reported from the field: bids could only be set when *creating* an ad group, so reacting to a delivery problem on an existing group meant editing it by hand in the Google Ads UI.
- **`prepare_campaign_update`** — update an existing campaign: name, status, daily budget, bidding strategy (with target CPA / target ROAS).
- **`prepare_ad_update`** — update an existing responsive search or responsive display ad: status, final URL, headlines, descriptions.
- **`get_display_remarketing_diagnostics`** — read-only delivery diagnostics for Display remarketing: `serving_status`, campaigns with no user list attached, audience size against the ~100-user Display minimum, `eligible_for_display`, membership duration, ad groups paused inside enabled campaigns, and manual CPC bids low enough to suppress delivery. When the campaign uses automated bidding it returns an explicit `bids_not_the_constraint` finding, because Google ignores ad group CPC bids there and raising them cannot fix delivery.
- Preview for every `*_update` tool reads the current values first and shows **before → after**, with the size of the change on amounts (`Max CPC: 0.20 PLN → 2.50 PLN (12.5x more)`), a warning when the campaign's bidding strategy makes a CPC change ineffective, and a warning when a budget is shared with other campaigns.
- `get_mutation_stats` now breaks `*_update` actions down by which fields were actually changed, so history keeps its resolution now that one action can carry several fields.
- `npm test` in `server/` runs the smoke suite (98 assertions): pure analyzers, limit helpers, tool contract, and a sweep that calls every money field of every registered tool with an absurd amount.

### Changed
- Amount limits are enforced in one place (`budgetLimitError` / `cpcLimitError` / `targetCpaLimitError`, plus a recursive `plnFieldLimitError` for nested `*_full` payloads) instead of a hand-copied `if` in each handler.
- Ad group and campaign `*_update` tools require at least one field, mirroring `meta-ads-baby`'s update tools.

### Fixed
- `target_cpa_pln` had no upper limit at all (in `prepare_bidding_strategy`), and neither did nested `cpc_bid_pln` / `target_cpa_pln` inside the `*_full` campaign payloads. All amount fields are now capped and covered by tests.

### Removed
- **`prepare_ad_group_settings`** — replaced by `prepare_ad_group_update`, which covers its only field (`optimized_targeting_enabled`) plus bid, status and name. Update any saved workflow that referenced the old name.

### Known limitation
- Amount caps and previews still say "PLN" while Google Ads works in **units of the account currency**. On a EUR/CZK/HUF account the cap is 500 units of that currency, not 500 zł, and the message is misleading. The next release adds the account currency to previews and limit messages, renames `*_pln` fields to `*_amount`, and makes the cap configurable.

## v0.15.1

### Fixed
- Remediated production dependency audit findings in the MCP server by updating `google-ads-api` and vulnerable transitive dependencies.

### Changed
- Rebuilt and committed `server/bundle.cjs` for the dependency-remediated server release.

## v0.15.0

### Added
- **Read-only analysis tools (P1 review loops).** Four tools that read an account, diagnose, and hand back structured follow-ups without ever mutating — each returns `findings` with `severity`, `metrics`, a `suggested_task` (ready for `append_task` in `marketing-context`, `source_type: review`), and possible `prepare_*` actions:
  - `get_account_hygiene_report` — daily-check scan: zero-spend, low budget utilization, spend-with-no-conversions.
  - `get_budget_scaling_candidates` — SEARCH/SHOPPING campaigns that are budget-constrained (utilization ≥ 90% **and** search IS lost to budget > 10%), pointing at the budget-scaling workflow.
  - `get_search_terms_waste_candidates` — negative-keyword candidates: cost ≥ threshold with 0 conversions in the recent window, with a longer-window cross-check that excludes historically-converting bounce-backs.
  - `get_pmax_channel_breakdown` — Performance Max asset-group cost/conversion breakdown with per-campaign share, flagging asset groups that burn budget with 0 conversions. (Google Ads exposes no clean per-channel PMax split via GAQL; the finer feed-only-leak check still needs the manual placement report.)
- Thresholds mirror BDOS `DAILY_DEFAULTS`/`MONTHLY_DEFAULTS` and the `google-ads-daily-check` / `google-ads-monthly-review` knowledge workflows; the decision logic lives in pure, unit-tested functions (`tools/analysis-helpers.ts`), covered by the smoke suite with synthetic rows. Live end-to-end verification against a real account is still pending (shared with the existing E2E TODO).

## v0.14.1

### Fixed
- Cursor/GitHub plugin startup now creates missing runtime directories before downloading `server/bundle.cjs`.
- Removed the interim `marketing-knowledge` MCP server and prompt hook from active plugin manifests. Use the dedicated `marketing-context-mcp` plugin for durable marketing memory.

## v0.14.0

### Changed
- Renamed the updater tool from `check_update` to `update_plugin`.
- The updater now refreshes plugin hook scripts when updating runtime files.

## v0.13.0

### Added
- **Marketing-knowledge store (interim)** — the plugin now wires a second MCP server, `marketing-knowledge`, backed by `@movibe/memory-bank-mcp` (pinned to `0.4.1`). It accumulates marketing know-how across sessions as plain, human-editable **markdown files** — separating general/cross-client knowledge from per-client notes. Point `MARKETING_KNOWLEDGE_DIR` at a folder inside your Google Drive / OneDrive sync to get cross-machine + team sharing without OAuth (the desktop sync client handles it). This is an interim adoption of an off-the-shelf Node server; the planned next step is domain wiring (auto-recording confirmed mutations into a per-client decision log via the safety hook).

## v0.12.0

### Added
- **Composite full-campaign tools** — `prepare_search_campaign_full`, `prepare_display_campaign_full`, `prepare_performance_max_campaign_full`: build a whole campaign (budget + campaign + bidding + geo/language + negatives + ad groups + keywords + responsive ads + extensions) in ONE atomic API transaction with a single confirmation. Drastically fewer model turns and confirm cycles than chaining granular `prepare_*` calls.
- **Presets** — pass a preset (`ecommerce-search-pl`, `leadgen-search-pl`) plus only the variable fields; the preset fills sane defaults (exact + phrase match, geo PL, language PL, conversion-based bidding with manual CPC fallback).
- **`get_build_context`** — one-shot read tool returning campaigns, ad groups, enabled conversion actions, and reusable image assets in a single call, so the model can plan a build without several round-trips.
- **Server instructions** — the MCP server now ships usage guidance steering clients toward the composite tools, batch confirmation (`confirm_all_mutations`), and PAUSED-by-default new campaigns.
- **`update_plugin` changelog** — update checks now show what changed between the local and remote versions, sourced from this file.

### Fixed
- Root `package.json` version was lagging behind the other manifests (the file `update_plugin` compares against); all manifests are now in sync.

## v0.11.0

### Added
- 6 new `prepare_*` tools (demographic bid modifiers, conversion goals, shared sets, ad schedules, keyword/ad status).
- Sitelink `final_urls` moved to asset level so URL query params work correctly.

## v0.10.0

### Added
- Mutation audit log (`mutation-history.jsonl`) with `get_mutation_history` / `get_mutation_stats`.
- Custom OAuth app credentials in the authorization flow.
