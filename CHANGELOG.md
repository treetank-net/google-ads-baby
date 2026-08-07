# Changelog

## v0.23.0

The queue became something you can steer, not just fill.

### Added
- **`discard_pending_mutations` drops prepared operations without executing them.** Omit `tokens` to
  clear the whole queue, pass tokens to drop only those. Nothing reaches Google Ads, so no safe word
  is required. Emptying the queue also resets the confirmation gate — and overwrites the safe-word
  file with a word nobody was shown rather than deleting it, because the hook reads a *missing* safe
  word as "any user message confirms".
- **`unfold_batch` takes a batch apart again**, into separately confirmable operations sharing one
  new server-minted safe word. This is how a single operation inside a batch gets corrected without
  retyping the others: unfold, discard the wrong one, prepare a fixed version, batch again.

### Changed
- **The batch hint in every `prepare_*` response now says what to do next**, not just that something
  is queued: keep preparing while more changes are coming, call `prepare_batch` with all the tokens
  once the set is complete (one confirmation instead of N), and drop unwanted operations with
  `discard_pending_mutations`.

### Fixed
- **The smoke suite no longer writes to the real config directory.** `createToken` saves the safe word
  to `~/.google-ads-baby/.gads-safe-word`, so running the tests overwrote the gate state of a live
  session — with a word the test itself contains. The batch tests now run against a temporary data
  directory.

## v0.22.0

Batching stopped being a decision you had to make before the first `prepare_*`.

### Added
- **`prepare_batch` folds already-prepared operations into one batch.** Pass the tokens of any
  pending operations — prepared minutes apart, each with its own safe word — and the server returns
  one combined preview plus **one new safe word it generates itself**, covering the whole set.
  `confirm_mutation` with the batch token then runs them in order. The folded tokens leave the queue,
  so the same change cannot run twice (once inside the batch, once on its own), and batches do not
  nest. A single invalid token rejects the batch without consuming the valid ones.
- **Every `prepare_*` response now says what else is waiting.** When the queue holds other
  unconfirmed operations, the response lists them (action, one-line preview, how long they waited)
  and points at `prepare_batch`. Folding stays an explicit call: the pending queue is shared by every
  session on the server process, so automatic merging would drag in operations this conversation
  never asked for.

### Notes
- The batch safe word is minted server-side, not invented by the model. The model cannot know it
  before the batch exists, so it cannot draft a prompt that already contains the word — the word can
  only come from the user's reply. The confirmation-state check compares against the batch token,
  which is newer than everything it folds, so a word typed before the batch was assembled cannot
  confirm it.
- A batch is sequential, not atomic: one API call per operation, so an earlier step can succeed while
  a later one fails. The preview says so. When a batch ends partially, the result names the failed
  steps and points at the mutation history entries (`batch-<token>`) that hold their full parameters
  for a fresh `prepare_*`. Whole-campaign creation stays atomic through the composite `*_full` tools,
  which are one `mutateResources` call.

## v0.21.2

`get_campaigns` hid the campaigns most worth looking at.

### Fixed
- **`get_campaigns` lists every campaign, not only the ones that served.** The query carried both
  `segments.date DURING LAST_N_DAYS` and `metrics.impressions > 0` in a single statement, so a
  campaign with no statistics row for the window returned nothing at all. On a live account with
  four PAUSED campaigns the tool answered "campaigns (0)" — the exact case a user asks about
  (paused, brand-new, or not serving) was the one case invisible. Structure and metrics are now two
  queries joined in code: campaigns drive the list, metrics are attached where they exist, and a
  campaign that served nothing reports zeros. `REMOVED` campaigns stay out.

## v0.21.1

The follow-up hardens account reads and mutation previews against live Google Ads states that the
first 0.21 release did not model correctly.

### Added
- **`list_entities` can read keywords and negative keywords**, with campaign/ad-group scoping,
  match-type and text filters, and the same bounded pagination as the other entity types.
- **Analysis excludes removed campaigns and assets** and reports paused Display campaigns as an
  informational `campaign_paused` finding instead of producing misleading delivery or bid alerts.

### Fixed
- **Enum values are decoded throughout structured ad blueprints and flat TSV output**, including
  policy statuses, pinned fields, asset performance labels, and asset references.
- **Updates to removed campaigns, ad groups, and ads are rejected during preparation** with the
  API's `OPERATION_NOT_PERMITTED_FOR_REMOVED_RESOURCE` reason, before a confirmation token is
  minted.

## v0.21.0

The plugin shipped with Poland baked into it. Two constants, `GEO_POLAND = '2616'` and
`LANG_POLISH = '1045'`, decided the country and language of every campaign built from a preset —
on a tool distributed to whoever installs it. One of the two was also simply wrong: `1045` is
**Afar**, not Polish. Polish is `1030`.

That mistake is the only reason it was ever caught. Afar is not targetable, so the API rejected the
whole composite with `CriterionError.CANNOT_TARGET_LANGUAGE` — after the user had already read a
preview claiming Polish and spent their confirmation on it. Had the typo landed on a targetable
language, the plugin would have quietly created campaigns in the wrong one and reported success.

### Breaking
- **`location_criterion_ids` and `language_criterion_ids` are replaced by `locations` and `languages`** in `prepare_search_campaign_full`, `prepare_display_campaign_full` and `prepare_campaign_targeting`. Both accept either an ISO code (`"PL"`, `"de"`) or a numeric criterion ID, so a region or city ID still works — one field instead of two, to keep the manifest from growing. They are **required** in the composite builders: a campaign with no stated market is a validation error, not a silent default.
- **Presets no longer carry a country or a language, and lost their `-pl` suffix**: `ecommerce-search-pl` → `ecommerce-search`, `leadgen-search-pl` → `leadgen-search`. A preset now sets match types and bidding — things that are true anywhere — and nothing geographic. No aliases, same reasoning as the `*_pln` → `*_amount` rename in 0.20.0.

### Added
- **`tools/targeting.ts` resolves ISO codes against the API** and caches the result for the life of the process. Languages are fetched once; geo targets are fetched per unseen code. The resolver checks `language_constant.targetable` and refuses a language Google will not accept, naming it: *"Language Afar (aa) is not targetable in Google Ads, so the campaign would be rejected."* That check now runs **before** the confirmation token is minted, so a bad market costs a retry, not a burned confirmation.
- **Previews name the targets instead of printing IDs.** `Geo targets: Poland (PL) — PRESENCE` and `Languages: Polish (pl)`, where the old preview showed `2616` and `1045` and no reader could have told they disagreed.
- **A `gaql` skill ships with the plugin** (`skills/gaql/SKILL.md`), covering the parts of GAQL that are not SQL — no `OR`, no parentheses, no `JOIN`, no `GROUP BY`, no aggregate functions — plus how enums and micros come back, how segments multiply rows, and a set of ready queries. Written from the errors this release produced.
- **Server instructions tell the model to ask which markets a campaign targets** and never to assume one.

### Fixed
- **Geo lookups no longer build a query GAQL cannot parse.** The first version filtered country codes and criterion IDs in one `WHERE` joined by `OR`; GAQL has neither `OR` nor grouping parentheses, so it passed the unit tests and failed on the first live call. Codes and IDs are now two separate queries, and a smoke test asserts no generated query contains ` OR `.
- **A failed targeting lookup reported `[object Object]`.** The resolver was interpolating the raw error instead of passing it through `formatError()`.


`prepare_budget_change` was showing the user a "before" amount it had never verified.

### Fixed
- **The budget preview took the current amount on the model's word.** Asked to change a budget that is actually 1 unit while being told it was 50, the tool previewed `50.00 PLN → 2.00 PLN (25.0x less)` — a cut, where the account was in fact about to get a 2x raise. Reproduced on a live account, not in theory. The tool now reads the amount from the account (`loadBudgetState()`) and previews that; `current_budget_amount` became optional and is only a cross-check, with a warning when it disagrees with what the account reports.
- **The one tool that mutates a budget directly by `budget_id` never mentioned sharing.** It now carries the same `sharedBudgetWarning()` as `prepare_campaign_update`, and lists the campaigns on that budget when more than one is attached — which is exactly the case where the caller cannot see the blast radius from the campaign they started at.

## v0.20.1

First release driven by running `prepare_*` against a live account instead of synthetic rows. Eight
prepare calls on a paused sandbox account produced five defects, all in the text a user reads before
deciding whether to confirm — the layer no unit test had been looking at.

### Fixed
- **A shared budget used by one campaign contradicted itself.** The preview said "shared by 1 campaign(s) … affects every campaign using it, not only this one" — a warning about other campaigns while stating there are none. The two cases are now separate: more than one reference is a warning, an `explicitly_shared` budget with a single reference is a neutral note that says the amount will be inherited by anything attached later.
- **`prepare_ad_update` hid what it was changing.** Editing headlines or descriptions previewed as "Descriptions: 2 item(s) → 2 item(s)", so a user could not see whether the new copy was right, or that the old copy was being dropped. New `textChangeLines()` prints both lists with `=` for kept, `-` for removed and `+` for added entries.
- **Amount change lines dropped decimals inconsistently.** `1 PLN → 3.5 PLN` for a budget change, because the shared formatter trimmed trailing zeros. Money in a `before → after` line now always shows two decimals (`1.00 PLN → 3.50 PLN`); the trimming formatter stays for prose.
- **`prepare_budget_change` drew its own arrow.** It printed `->` while every other preview printed `→`, and it computed the change text separately from the shared helper. It now goes through `microsChangeLine()`, so it also gains the multiple/percent annotation the other tools had.
- **The OAuth page saved an MCC ID it could not reach.** `/save-config` wrote `loginCustomerId` without checking it, and the next call failed with a raw `USER_PERMISSION_DENIED` from the API with nothing pointing at the cause. It broke a real session during this test. The endpoint now verifies access before saving and returns a message naming the accounts the token can actually see.

## v0.20.0

The plugin claimed every amount was in PLN. On the EUR, CZK and HUF accounts in the same MCC that
was simply false — micros are always in the account currency, and nothing converted them. The
budget cap said "500 PLN/day" while enforcing 500 units of whatever the account used: about
2 100 zł on a EUR account and about 5 zł on a HUF one. This release removes the lie.

### Breaking
- **Every `*_pln` tool field is renamed to `*_amount`**: `daily_budget_pln` → `daily_budget_amount`, `new_budget_pln` → `new_budget_amount`, `current_budget_pln` → `current_budget_amount`, `cpc_bid_pln` → `cpc_bid_amount`, `target_cpa_pln` → `target_cpa_amount`, including the nested fields inside the `*_full` builders. No aliases were kept: the consumer of these schemas is a model reading the manifest live, and carrying both names would have added roughly 2 000 tokens to a manifest that 0.19.0 had just cut down. Saved prompts or notes that spell out `daily_budget_pln` need updating; the model itself picks up the new name from the schema.

### Added
- **Amounts carry the account currency.** `getAccountCurrency()` reads `customer.currency_code` once per account and caches it. Previews, limit messages and `before → after` lines now render through `formatAmount(micros, currency)`, so a EUR account is told "125 EUR", not "125 PLN". When the currency cannot be read the text says "account currency unit(s)" rather than guessing PLN.
- **Safety caps scale with the currency** instead of being one number everywhere. Defaults are 500 / 50 / 500 units on PLN and scale by `CURRENCY_UNIT_SCALE`: PLN 1, EUR/USD/GBP/CHF 0.25, BGN 0.5, RON 1.25, DKK 2, SEK/NOK 2.5, CZK 5, UAH 10, HUF 100. An unknown currency keeps the PLN numbers — the strictest option for a weak currency, chosen deliberately.
- **`GOOGLE_ADS_MAX_DAILY_BUDGET`, `GOOGLE_ADS_MAX_CPC` and `GOOGLE_ADS_MAX_TARGET_CPA`** set caps in account currency units. An explicit value is used exactly as given and is not scaled, so a EUR account can be pinned to 80 EUR/day without reasoning about exchange rates. They can also be saved in `config.json`.

### Fixed
- **Diagnostic cost thresholds were money too, and were equally wrong.** The waste floor of 50 units is about 0.5 zł on a HUF account, so `get_account_hygiene_report` and `get_search_terms_waste_candidates` would have flagged essentially every campaign that ever spent anything; on EUR the same floor is about 215 zł and would have hidden real waste. The `lowCpcUnits: 0.1` floor in the Display diagnostics had the same problem. Thresholds ending in `Units` are now scaled by the account currency; ratios and day counts are untouched. Each report returns the account `currency`, and says in `thresholds_note` when scaling was applied or when the currency could not be read.

### Changed
- Suite is at 225 assertions. New ones cover the scale table, the configured-cap overrides (including that a nonsense or negative value is ignored rather than treated as zero), that limit messages no longer contain "PLN", and that the same spend is waste on a PLN account but not on a HUF one.
- The `full` manifest grew from 21 248 to 21 433 tokens (`manage` 10 352 → 10 424, `read` unchanged) because the amount fields now say which currency they are in. Worth 185 tokens.

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
