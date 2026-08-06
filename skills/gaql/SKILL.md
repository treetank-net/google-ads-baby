---
name: gaql
description: Writing Google Ads Query Language (GAQL) queries for the execute_gaql tool — syntax that GAQL does not support (OR, parentheses, JOIN, GROUP BY, aggregate functions), how enums and money come back, date ranges, segmentation, and ready-made queries for common questions. Use whenever building or debugging a GAQL query, or when execute_gaql returns an error or an empty result.
---

# GAQL for google-ads-baby

`execute_gaql` runs a read-only GAQL query against one account. GAQL looks like SQL and is not
SQL — most of the surprises below come from assuming otherwise.

## What GAQL does not have

These are not limitations of this plugin. The API rejects them.

- **No `OR`.** Only `AND` joins conditions. Two alternatives = two queries, merged in your head.
- **No parentheses for grouping.** `WHERE (a AND b) OR c` is a syntax error twice over.
- **No `JOIN`.** One `FROM` resource per query. Related fields come from the implicit hierarchy: querying `FROM ad_group_criterion` lets you select `campaign.name` and `ad_group.name` for free.
- **No `GROUP BY`, no `SUM()`, `COUNT()`, `AVG()`.** Aggregation is implicit: the grain of a row is decided by which resource you query and which `segments.*` fields you select. Add up numbers yourself.
- **No subqueries, no `UNION`, no `HAVING`, no aliases, no `SELECT *`.** Every field is named explicitly.
- **No mutations.** `execute_gaql` also refuses any query matching `CREATE`, `UPDATE`, `REMOVE` or `MUTATE` before it reaches the API. Changes go through `prepare_*` tools.

Strings use **single quotes**: `WHERE campaign.name = 'Brand'`. Double quotes fail.

## Enums come back as numbers

`campaign.status` is `2`, not `'ENABLED'`. This is the single most common way to write a query that
runs fine and answers the wrong question.

- **In a `WHERE` clause, write the name**: `WHERE campaign.status = 'ENABLED'` — the API parses names on input.
- **In the result, you get a number.** `format: 'tsv'` (the default) decodes the columns it knows; anything outside that map stays numeric. `format: 'json'` never decodes and costs several times more context.
- **Never compare a returned value to a string in your head or in code.** `status = 3` is `PAUSED`; `2` is `ENABLED`; `4` is `REMOVED`. If a column comes back as a bare number and you are about to reason about it, look it up rather than guessing — the numbering is per-enum, so `3` means `MANUAL_CPC` on `bidding_strategy_type` and `PAUSED` on `status`.

Filtering by status is almost always what you want. A query with no status filter includes
**removed** campaigns, ad groups and keywords, and they look exactly like live ones in a table.

## Money is micros

Every `*_micros` field is 1/1 000 000 of one unit of **the account currency** — never converted,
never PLN by default. Divide by 1 000 000 to get units. `list_accounts` shows each account's
currency; state amounts in that currency or not at all.

`metrics.cost_micros`, `campaign_budget.amount_micros`, `ad_group.cpc_bid_micros`,
`metrics.average_cpc` are all micros.

## Dates and segments

```sql
WHERE segments.date DURING LAST_30_DAYS
WHERE segments.date BETWEEN '2026-07-01' AND '2026-07-31'
WHERE segments.date >= '2026-07-01'
```

Named ranges include `TODAY`, `YESTERDAY`, `LAST_7_DAYS`, `LAST_30_DAYS`, `THIS_MONTH`,
`LAST_MONTH`. Dates are in the **account's** time zone.

Two things about segments that bite:

1. **Selecting a `segments.*` field multiplies rows.** Add `segments.date` and one campaign becomes 30 rows. Add `segments.device` on top and it becomes 120. Only select a segment you intend to break the numbers down by.
2. **Metrics without a date filter default to the last 7 days on most resources.** If a number looks too small, check whether you set a range at all.

Resources whose name ends in `_view` (`search_term_view`, `keyword_view`,
`campaign_audience_view`) only have rows where something actually happened. An empty result there
means no traffic, not a broken query.

## Reading a result

- Sort in the query, not afterwards: `ORDER BY metrics.cost_micros DESC`.
- `LIMIT` in the query bounds **what is fetched from the API**. It is not needed for context safety — this plugin paginates responses by rendered size and tells you which page of how many. Use `page: N` for the next slice; nothing is silently dropped.
- Resource names come back as `customers/1234567890/campaigns/987`. TSV shortens them to the trailing ID. To filter on one, compare the whole string: `WHERE campaign.resource_name = 'customers/1234567890/campaigns/987'`, or filter on `campaign.id = 987` instead, which is easier.
- Some field combinations are rejected as incompatible (typically a metric that has no meaning at the grain of the selected segments). Drop the segment or the metric — there is no way to force it.

## Query recipes

**Where the money went last month**
```sql
SELECT campaign.name, campaign.status, metrics.cost_micros, metrics.clicks,
       metrics.impressions, metrics.conversions
FROM campaign
WHERE segments.date DURING LAST_MONTH AND campaign.status != 'REMOVED'
ORDER BY metrics.cost_micros DESC
```

**Keywords that spend and never convert**
```sql
SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text,
       ad_group_criterion.keyword.match_type, metrics.cost_micros, metrics.conversions
FROM keyword_view
WHERE segments.date DURING LAST_30_DAYS
  AND metrics.conversions = 0
  AND ad_group_criterion.status = 'ENABLED'
ORDER BY metrics.cost_micros DESC
```

**Search terms worth a negative keyword**
```sql
SELECT search_term_view.search_term, campaign.name, metrics.cost_micros,
       metrics.clicks, metrics.conversions
FROM search_term_view
WHERE segments.date DURING LAST_30_DAYS AND metrics.clicks > 0
ORDER BY metrics.cost_micros DESC
```

**Budgets, and which campaigns share one**
```sql
SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros,
       campaign_budget.explicitly_shared, campaign_budget.reference_count
FROM campaign_budget
```

**Is this campaign actually able to serve**
```sql
SELECT campaign.name, campaign.status, campaign.serving_status,
       campaign.advertising_channel_type, campaign.bidding_strategy_type
FROM campaign
WHERE campaign.status = 'ENABLED'
```

**Ad-level performance with the creative text**
```sql
SELECT ad_group.name, ad_group_ad.ad.id, ad_group_ad.status,
       ad_group_ad.ad.responsive_search_ad.headlines,
       metrics.impressions, metrics.clicks, metrics.conversions
FROM ad_group_ad
WHERE segments.date DURING LAST_30_DAYS AND ad_group_ad.status != 'REMOVED'
```

**What a campaign targets** (geo and language criteria)
```sql
SELECT campaign.name, campaign_criterion.type, campaign_criterion.location.geo_target_constant,
       campaign_criterion.language.language_constant, campaign_criterion.negative
FROM campaign_criterion
WHERE campaign.id = 123456789
```

**Resolve a country or language code to a criterion ID** — note the two queries, because `OR`
does not exist. The `prepare_*` tools resolve ISO codes for you; this is for checking by hand.
```sql
SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code
FROM geo_target_constant
WHERE geo_target_constant.country_code IN ('PL', 'CZ') AND geo_target_constant.target_type = 'Country'
```
```sql
SELECT language_constant.id, language_constant.code, language_constant.name,
       language_constant.targetable
FROM language_constant WHERE language_constant.code = 'pl'
```
Language IDs are not guessable and near-misses are real languages: `1030` is Polish, `1045` is
Afar. Always resolve, never hardcode.

## Before writing a custom query

Several questions already have a purpose-built tool that returns findings instead of rows —
`get_account_hygiene_report`, `get_budget_scaling_candidates`, `get_search_terms_waste_candidates`,
`get_pmax_channel_breakdown`, `get_display_remarketing_diagnostics`. For plain listings,
`list_ads_entities` and `get_campaigns` are cheaper than hand-written GAQL. Reach for
`execute_gaql` when the question is genuinely bespoke.
