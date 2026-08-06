# Changelog

## v0.19.0

### Added
- **`GOOGLE_ADS_BABY_PROFILE` limits which tools are registered.** The 62-tool manifest costs 21 248 tokens of context before anything is asked, in every session. Two smaller profiles are now available:

  | Profile | Tools | Manifest | Saved |
  | --- | --- | --- | --- |
  | `full` (default) | 62 | 21 248 tok | — |
  | `manage` | 38 | 10 352 tok | −10 896 |
  | `read` | 15 | 3 783 tok | −17 465 |

  `read` registers reads, the five analysis reports, mutation history and auth — no `prepare_*`, no `confirm_*`, so mutation is impossible rather than merely discouraged. `manage` adds edits to existing entities (budget, bids, status, text, targeting, schedules) but not creation, assets, cloning or the composite `*_full` builders. Default behaviour is unchanged.
- The server tells the model which profile is active and what it excludes, and stops advertising tools it did not register — a `manage` session no longer reads instructions recommending `prepare_search_campaign_full`. Without this the model would look for a workaround instead of telling the user to change the profile.

### Fixed
- **The MCP server reported `version: 0.14.0`.** The string was hard-coded in `index.ts` and had not moved in four releases, so clients saw a version four releases stale. It now comes from `PLUGIN_VERSION`, and a test compares that constant against `package.json` so the drift cannot come back.

### Changed
- Suite is at 192 assertions. The profile tests cross-check `TOOL_PROFILE` against the registered tools in both directions; that check immediately caught eight unclassified tools and four map entries naming tools that do not exist.

## v0.18.0

0.17.0 made responses compact but kept the old habit of *truncating* them. Truncation loses
data; pagination does not. Every read tool that can return many rows now splits its response
into pages sized by how much the rendered output actually costs.

### Changed
- **`list_ads_entities`, `list_accounts`, `get_campaigns` and `execute_gaql` are paginated instead of capped.** `page` selects the slice, `page_chars` overrides the ~40 000-character budget, and the response states which page of how many, which rows, and how to ask for the next one. The split follows real rendered size, not a row count: a 500-character-per-row result yields ~70 rows per page while a narrow one yields hundreds.
- **`list_ads_entities`'s `limit` is now a fetch bound, not a display bound** (default 2000, max 5000, was 50/200). `customer.query()` already pages through the API internally, so the old GAQL `LIMIT 50` was *our* truncation, not Google's — asking for 500 ads and being handed 50 with "there may be more" was the tool discarding rows it had every ability to return.
- **Analysis findings paginate rather than cap at 25.** Findings stay sorted most-severe-first, so page 1 still carries the criticals, and `summary` still counts all of them — but the tail is now reachable instead of gone. Pagination measures the JSON these reports actually emit, not a TSV stand-in.
- **The Display audience-coverage table is no longer trimmed to 40 rows.** It is ordered by how many enabled campaigns use each list and paginated.
- An empty repeated field no longer produces an empty column.

### Added
- 18 pagination assertions, including that every row appears on exactly one page across the whole page range, that a page fits its character budget, that out-of-range page numbers clamp, and that a non-TSV renderer is honoured. Suite is at 166 assertions.

### Removed
- `capFindings`, `omittedFindingsNote`, `trimAudienceCoverage` and their limits (`FINDINGS_LIMIT`, `AUDIENCE_COVERAGE_LIMIT`) — replaced by `paginate` / `pageNote` and `rankAudienceCoverage`.

## v0.17.0

Read tools returned pretty-printed JSON, which spends most of its bytes repeating
key names once per row. Measured against a live 42-campaign account, the list-shaped
read tools now return tab-separated tables instead — same data, a fraction of the context.

### Changed
- **`list_ads_entities`, `get_build_context`, `get_campaigns`, `list_accounts` and `execute_gaql` return TSV tables** with one header row per section. Ids are bare (the `customers/123/campaigns/456` prefix is dropped — it repeated once per row), enum numbers are decoded to names, and repeated text fields (ad headlines, descriptions) are joined with ` ~ `. Measured on the same live account:

  | Tool | Before | After | |
  | --- | --- | --- | --- |
  | `list_ads_entities(ads)`, 50 rows | 16 150 tok | 2 715 tok | −83% |
  | `list_ads_entities(ad_groups)` | 6 398 tok | 1 570 tok | −75% |
  | `list_ads_entities(assets)` | 3 343 tok | 846 tok | −76% |
  | `get_build_context` | 32 152 tok | 11 917 tok | −63% |
  | `list_accounts` | 802 tok | 318 tok | −60% |
  | `get_campaigns` | 647 tok | 311 tok | −52% |

  `get_build_context` alone was spending a sixth of a 200k window on a single call — the tool that exists to *save* round-trips was the most expensive thing in the plugin.
- `execute_gaql` takes `format: tsv | json` (default `tsv`). Pass `json` when you need the raw API rows.
- Non-integer metrics are printed to 6 significant digits. A CTR of `0.12375415282392027` carried 19 characters of precision nobody uses; integers and `*_micros` values are never rounded.
- `audience_coverage` in the Display diagnostics is a TSV table rather than an array of objects.
- `list_ads_entities` says so when a result sits exactly at the limit, instead of silently looking complete.
- The `safe_word` description is defined once on the shared schema. Thirty tools carried one wording and ten another, for the same field.

### Notes on what was *not* done
- **Trimming schema descriptions was measured and rejected.** The manifest is ~20 400 tokens for 62 tools, but only 4 151 of that is field descriptions across 328 fields (~47 chars each); the rest is Zod-to-JSON-Schema structure. Consolidating the most-repeated description saved 79 tokens — 0.4%. Cutting the longer ones would have cost real information, including the warnings that stop a caller from changing a bid the campaign's bidding strategy ignores.
- Decoding enums makes some tables slightly *larger* (`SEARCH_STANDARD` is longer than `2`). That is a deliberate trade: 0.16.1 shipped precisely because raw enum numbers had been reaching users and the code itself.

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
