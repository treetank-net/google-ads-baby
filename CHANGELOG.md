# Changelog

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
