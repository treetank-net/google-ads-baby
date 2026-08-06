import { z } from 'zod';
import { enums } from 'google-ads-api';

export type Severity = 'critical' | 'warning' | 'info';

type EnumTable = Record<string | number, string | number>;

export function enumLabel(table: EnumTable, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' && !/^\d+$/.test(value)) return value;
  const name = table[value as keyof EnumTable];
  return typeof name === 'string' ? name : String(value);
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface SuggestedTask {
  title: string;
  intent: string;
  suggested_workflow: string;
  source_type: 'review';
  reason: string;
  context?: string;
}

export interface Finding {
  code: string;
  severity: Severity;
  entity: string;
  observation: string;
  metrics: Record<string, number | string>;
  suggested_task: SuggestedTask;
  prepare_actions: string[];
}

export const MICROS = 1_000_000;

export function toUnits(micros: number | string | undefined): number {
  return Math.round((Number(micros ?? 0) / MICROS) * 100) / 100;
}

function rate(value: number, base: number): number {
  return base > 0 ? Math.round((value / base) * 1000) / 1000 : 0;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function summarize(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

// Thresholds mirror BDOS DAILY_DEFAULTS / MONTHLY_DEFAULTS and the
// google-ads-daily-check / google-ads-monthly-review knowledge workflows.
// Amounts are in account currency units (tuned for PLN accounts); override
// per call where the tool exposes a parameter.
export const HYGIENE_DEFAULTS = {
  lowUtil: 0.2, // budget utilization below this is a low-util flag
  minDailyBudgetUnits: 20, // ignore trivial budgets for low-util
  zeroSpendBudgetUnits: 30, // enabled campaign with >= this daily budget and ~0 spend
  zeroSpendCostFloorUnits: 1, // spend at or below this counts as "no spend"
  noConvCostFloorUnits: 50, // spend at or above this with 0 conversions is wasteful
};

export const SCALING_DEFAULTS = {
  minUtil: 0.9, // budget utilization at or above this = budget-constrained
  minBudgetLostIS: 0.1, // search IS lost to budget above this = headroom to scale
};

export const WASTE_DEFAULTS = {
  minCostUnits: 50, // per-term 30d cost at or above this with 0 conversions
};

export const PMAX_DEFAULTS = {
  assetGroupWasteCostUnits: 50, // asset group cost at or above this with 0 conversions
  lowShareRatio: 0.5, // asset group / channel share below this on a spending campaign
};

const scheduleAliasSchema = z.string().min(1);

export const analysisWindowSchema = z.enum(['7', '14', '30']).default('30');
export const monthlyWindowSchema = z.enum(['30', '60', '90']).default('30');
export { scheduleAliasSchema };

// ---- GAQL window + query builders ----

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Window ending yesterday (never today — today's data is incomplete), spanning
// `days` days back. Returned as a GAQL BETWEEN clause so any length works
// (LAST_N_DAYS constants only cover 7/14/30).
export function windowClause(days: number): string {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return `segments.date BETWEEN '${isoDate(start)}' AND '${isoDate(end)}'`;
}

export function buildHygieneQuery(clause: string): string {
  return `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.cost_micros, metrics.conversions, metrics.conversions_value,
      metrics.clicks, metrics.impressions
    FROM campaign
    WHERE ${clause}
      AND campaign.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
  `;
}

export function buildScalingQuery(clause: string): string {
  return `
    SELECT
      campaign.id, campaign.name, campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.cost_micros, metrics.conversions, metrics.conversions_value,
      metrics.search_budget_lost_impression_share,
      metrics.search_impression_share
    FROM campaign
    WHERE ${clause}
      AND campaign.status = 'ENABLED'
      AND campaign.advertising_channel_type IN ('SEARCH','SHOPPING')
    ORDER BY metrics.cost_micros DESC
  `;
}

export function buildSearchTermsQuery(clause: string): string {
  return `
    SELECT
      search_term_view.search_term,
      campaign.id, campaign.name,
      metrics.cost_micros, metrics.conversions, metrics.clicks
    FROM search_term_view
    WHERE ${clause}
    ORDER BY metrics.cost_micros DESC
  `;
}

export function buildPmaxQuery(clause: string): string {
  return `
    SELECT
      campaign.id, campaign.name,
      asset_group.id, asset_group.name, asset_group.status,
      metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM asset_group
    WHERE ${clause}
      AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
    ORDER BY metrics.cost_micros DESC
  `;
}

// ---- Account hygiene (daily-check window) ----

export interface HygieneRow {
  campaign?: { id?: string | number; name?: string; status?: string; advertising_channel_type?: string };
  campaign_budget?: { amount_micros?: string | number };
  metrics?: {
    cost_micros?: string | number;
    conversions?: number;
    conversions_value?: number;
    clicks?: number;
    impressions?: number;
  };
}

export function analyzeAccountHygiene(
  rows: HygieneRow[],
  windowDays: number,
  t = HYGIENE_DEFAULTS,
): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const name = row.campaign?.name ?? String(row.campaign?.id ?? 'unknown');
    const entity = `campaign ${name}`;
    const costUnits = toUnits(row.metrics?.cost_micros);
    const dailyCost = windowDays > 0 ? costUnits / windowDays : costUnits;
    const dailyBudget = toUnits(row.campaign_budget?.amount_micros);
    const conversions = Number(row.metrics?.conversions ?? 0);
    const util = dailyBudget > 0 ? dailyCost / dailyBudget : 0;

    if (dailyBudget >= t.zeroSpendBudgetUnits && dailyCost <= t.zeroSpendCostFloorUnits) {
      findings.push({
        code: 'zero_spend',
        severity: 'critical',
        entity,
        observation: `Enabled campaign with ${dailyBudget} daily budget but ~0 spend over ${windowDays}d — likely disapproved, learning-stalled, or targeting-starved.`,
        metrics: { daily_budget: dailyBudget, daily_cost: dailyCost, window_days: windowDays },
        suggested_task: {
          title: `Investigate zero-spend campaign: ${name}`,
          intent: 'google_ads_daily_check',
          suggested_workflow: 'google-ads/google-ads-daily-check.md',
          source_type: 'review',
          reason: 'Enabled campaign with a real budget is not spending.',
          context: `campaign_id=${row.campaign?.id}; daily_budget=${dailyBudget}; daily_cost=${dailyCost}`,
        },
        prepare_actions: [],
      });
      continue;
    }

    if (dailyBudget >= t.minDailyBudgetUnits && util > 0 && util < t.lowUtil) {
      findings.push({
        code: 'low_utilization',
        severity: 'warning',
        entity,
        observation: `Budget utilization ${(util * 100).toFixed(0)}% (< ${t.lowUtil * 100}%) — budget likely oversized for the campaign's reach.`,
        metrics: { utilization: util, daily_budget: dailyBudget, daily_cost: dailyCost },
        suggested_task: {
          title: `Right-size budget for low-util campaign: ${name}`,
          intent: 'google_ads_daily_check',
          suggested_workflow: 'google-ads/google-ads-daily-check.md',
          source_type: 'review',
          reason: 'Budget consistently underused; the cap is not the constraint.',
          context: `campaign_id=${row.campaign?.id}; utilization=${util}; daily_budget=${dailyBudget}`,
        },
        prepare_actions: ['prepare_budget_change'],
      });
    }

    if (costUnits >= t.noConvCostFloorUnits && conversions === 0) {
      findings.push({
        code: 'spend_no_conversions',
        severity: 'warning',
        entity,
        observation: `Spent ${costUnits} over ${windowDays}d with 0 conversions — check conversion tracking, then targeting/bidding.`,
        metrics: { cost: costUnits, conversions, window_days: windowDays },
        suggested_task: {
          title: `Zero-conversion spend on ${name}`,
          intent: 'google_ads_daily_check',
          suggested_workflow: 'google-ads/google-ads-daily-check.md',
          source_type: 'review',
          reason: 'Real spend with no conversions — tracking break or wasted budget.',
          context: `campaign_id=${row.campaign?.id}; cost=${costUnits}; window_days=${windowDays}`,
        },
        prepare_actions: [],
      });
    }
  }
  return sortFindings(findings);
}

// ---- Budget scaling candidates (monthly-review) ----

export interface ScalingRow {
  campaign?: { id?: string | number; name?: string; advertising_channel_type?: string };
  campaign_budget?: { amount_micros?: string | number };
  metrics?: {
    cost_micros?: string | number;
    conversions?: number;
    conversions_value?: number;
    search_budget_lost_impression_share?: number;
    search_impression_share?: number;
  };
}

export function analyzeScalingCandidates(
  rows: ScalingRow[],
  windowDays: number,
  t = SCALING_DEFAULTS,
): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const name = row.campaign?.name ?? String(row.campaign?.id ?? 'unknown');
    const costUnits = toUnits(row.metrics?.cost_micros);
    const dailyCost = windowDays > 0 ? costUnits / windowDays : costUnits;
    const dailyBudget = toUnits(row.campaign_budget?.amount_micros);
    const util = dailyBudget > 0 ? dailyCost / dailyBudget : 0;
    const lostIS = Number(row.metrics?.search_budget_lost_impression_share ?? 0);
    const conversions = Number(row.metrics?.conversions ?? 0);
    const value = Number(row.metrics?.conversions_value ?? 0);
    const roas = costUnits > 0 ? Math.round((value / costUnits) * 100) / 100 : 0;

    if (util >= t.minUtil && lostIS > t.minBudgetLostIS) {
      findings.push({
        code: 'budget_scaling_candidate',
        severity: conversions > 0 ? 'warning' : 'info',
        entity: `campaign ${name}`,
        observation: `Budget-constrained: util ${(util * 100).toFixed(0)}% and ${(lostIS * 100).toFixed(0)}% search IS lost to budget. Scaling could capture more volume.`,
        metrics: { utilization: util, budget_lost_is: lostIS, roas, conversions, daily_budget: dailyBudget },
        suggested_task: {
          title: `Evaluate budget scaling: ${name}`,
          intent: 'google_ads_monthly_review',
          suggested_workflow: 'google-ads/budget-scaling-seasonality.md',
          source_type: 'review',
          reason: `Budget is the constraint (util ${(util * 100).toFixed(0)}%, IS-lost-budget ${(lostIS * 100).toFixed(0)}%).`,
          context: `campaign_id=${row.campaign?.id}; util=${util}; budget_lost_is=${lostIS}; roas=${roas}`,
        },
        prepare_actions: ['prepare_budget_change'],
      });
    }
  }
  return sortFindings(findings);
}

// ---- Search-terms waste (monthly-review, 90d cross-check) ----

export interface SearchTermRow {
  search_term_view?: { search_term?: string };
  campaign?: { id?: string | number; name?: string };
  metrics?: { cost_micros?: string | number; conversions?: number; clicks?: number };
}

interface TermAgg {
  term: string;
  cost: number;
  conversions: number;
  campaigns: Set<string>;
}

function aggregateTerms(rows: SearchTermRow[]): Map<string, TermAgg> {
  const map = new Map<string, TermAgg>();
  for (const row of rows) {
    const term = row.search_term_view?.search_term;
    if (!term) continue;
    const agg = map.get(term) ?? { term, cost: 0, conversions: 0, campaigns: new Set<string>() };
    agg.cost += toUnits(row.metrics?.cost_micros);
    agg.conversions += Number(row.metrics?.conversions ?? 0);
    const cname = row.campaign?.name ?? String(row.campaign?.id ?? '');
    if (cname) agg.campaigns.add(cname);
    map.set(term, agg);
  }
  return map;
}

export function analyzeSearchTermsWaste(
  rows30: SearchTermRow[],
  rows90: SearchTermRow[],
  t = WASTE_DEFAULTS,
): { findings: Finding[]; excluded_bounce_back: string[] } {
  const recent = aggregateTerms(rows30);
  const longWindow = aggregateTerms(rows90);
  const findings: Finding[] = [];
  const excluded: string[] = [];

  for (const agg of recent.values()) {
    if (agg.cost < t.minCostUnits || agg.conversions > 0) continue;
    const historical = longWindow.get(agg.term);
    if (historical && historical.conversions > 0) {
      // Bounce-back: converted historically → last-month anomaly, not waste.
      excluded.push(agg.term);
      continue;
    }
    const campaigns = [...agg.campaigns].join(', ');
    findings.push({
      code: 'search_term_waste',
      severity: agg.cost >= t.minCostUnits * 2 ? 'warning' : 'info',
      entity: `search term "${agg.term}"`,
      observation: `Cost ${agg.cost} in 30d, 0 conversions, and no conversions in 90d — negative-keyword candidate.`,
      metrics: { cost_30d: agg.cost, conversions_30d: agg.conversions, conversions_90d: historical?.conversions ?? 0 },
      suggested_task: {
        title: `Add negative: "${agg.term}"`,
        intent: 'google_ads_monthly_review',
        suggested_workflow: 'google-ads/google-ads-monthly-review.md',
        source_type: 'review',
        reason: 'Sustained spend with no conversions in 30d or 90d.',
        context: `term="${agg.term}"; campaigns=${campaigns}; cost_30d=${agg.cost}`,
      },
      prepare_actions: ['prepare_negative_keywords'],
    });
  }
  return { findings: sortFindings(findings), excluded_bounce_back: excluded.sort() };
}

// ---- PMax asset-group breakdown ----

export interface PmaxAssetGroupRow {
  campaign?: { id?: string | number; name?: string };
  asset_group?: { id?: string | number; name?: string; status?: string };
  metrics?: { cost_micros?: string | number; conversions?: number; conversions_value?: number };
}

export function analyzePmaxBreakdown(
  rows: PmaxAssetGroupRow[],
  t = PMAX_DEFAULTS,
): { findings: Finding[]; breakdown: Array<Record<string, number | string>> } {
  const findings: Finding[] = [];
  const byCampaign = new Map<string, { name: string; total: number; groups: PmaxAssetGroupRow[] }>();
  for (const row of rows) {
    const cid = String(row.campaign?.id ?? 'unknown');
    const entry = byCampaign.get(cid) ?? { name: row.campaign?.name ?? cid, total: 0, groups: [] };
    entry.total += toUnits(row.metrics?.cost_micros);
    entry.groups.push(row);
    byCampaign.set(cid, entry);
  }

  const breakdown: Array<Record<string, number | string>> = [];
  for (const [cid, entry] of byCampaign) {
    for (const g of entry.groups) {
      const cost = toUnits(g.metrics?.cost_micros);
      const conv = Number(g.metrics?.conversions ?? 0);
      const share = entry.total > 0 ? Math.round((cost / entry.total) * 1000) / 1000 : 0;
      const gname = g.asset_group?.name ?? String(g.asset_group?.id ?? 'unknown');
      breakdown.push({ campaign: entry.name, asset_group: gname, cost, conversions: conv, share });

      if (cost >= t.assetGroupWasteCostUnits && conv === 0) {
        findings.push({
          code: 'pmax_asset_group_no_conversions',
          severity: 'warning',
          entity: `asset group ${gname} (${entry.name})`,
          observation: `Asset group spent ${cost} (${(share * 100).toFixed(0)}% of campaign) with 0 conversions — review assets/audience signals or exclude.`,
          metrics: { cost, conversions: conv, share, campaign_id: cid },
          suggested_task: {
            title: `Review PMax asset group: ${gname}`,
            intent: 'google_ads_monthly_review',
            suggested_workflow: 'google-ads/google-ads-daily-check.md',
            source_type: 'review',
            reason: 'PMax asset group consuming budget with no conversions.',
            context: `campaign=${entry.name}; asset_group=${gname}; cost=${cost}; share=${share}`,
          },
          prepare_actions: [],
        });
      }
    }
  }
  return { findings: sortFindings(findings), breakdown };
}

// ---- Display remarketing delivery diagnostics ----

export const DISPLAY_REMARKETING_DEFAULTS = {
  minDisplayListSize: 100, // Display needs roughly this many active users before it serves
  lowCpcUnits: 0.1, // manual CPC at or below this is a plausible delivery blocker
  minDailyBudgetUnits: 5, // ignore trivially small budgets when flagging zero impressions
  shortMembershipDays: 7, // very short membership windows shrink a remarketing list fast
};

const SERVING_STATUSES_OK = new Set(['SERVING', 'ELIGIBLE']);

export interface DisplayCampaignRow {
  campaign?: { id?: string | number; name?: string; status?: string; serving_status?: string; bidding_strategy_type?: string };
  campaign_budget?: { amount_micros?: string | number };
  metrics?: { impressions?: number | string; cost_micros?: number | string };
}

export interface DisplayAdGroupRow {
  campaign?: { id?: string | number; name?: string; status?: string };
  ad_group?: { id?: string | number; name?: string; status?: string; cpc_bid_micros?: number | string };
}

export interface DisplayAudienceRow {
  campaign?: { id?: string | number };
  ad_group?: { id?: string | number; name?: string };
  ad_group_criterion?: { user_list?: { user_list?: string }; status?: string };
}

export interface UserListRow {
  user_list?: {
    id?: string | number;
    name?: string;
    resource_name?: string;
    size_for_display?: number | string;
    size_for_search?: number | string;
    eligible_for_display?: boolean;
    membership_life_span?: number | string;
  };
}

export function buildDisplayCampaignQuery(clause: string): string {
  return `
    SELECT
      campaign.id, campaign.name, campaign.status, campaign.serving_status,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros,
      metrics.impressions, metrics.cost_micros
    FROM campaign
    WHERE ${clause}
      AND campaign.advertising_channel_type = 'DISPLAY'
  `;
}

export function buildDisplayAdGroupQuery(): string {
  return `
    SELECT
      campaign.id, campaign.name, campaign.status,
      ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros
    FROM ad_group
    WHERE campaign.advertising_channel_type = 'DISPLAY'
      AND ad_group.status != 'REMOVED'
  `;
}

export function buildDisplayAudienceQuery(): string {
  return `
    SELECT
      campaign.id,
      ad_group.id, ad_group.name,
      ad_group_criterion.status,
      ad_group_criterion.user_list.user_list
    FROM ad_group_criterion
    WHERE campaign.advertising_channel_type = 'DISPLAY'
      AND ad_group_criterion.type = 'USER_LIST'
      AND ad_group_criterion.status != 'REMOVED'
  `;
}

export function buildUserListQuery(): string {
  return `
    SELECT
      user_list.id, user_list.name, user_list.resource_name,
      user_list.size_for_display, user_list.size_for_search,
      user_list.eligible_for_display,
      user_list.membership_life_span
    FROM user_list
  `;
}

export const FINDINGS_LIMIT = 25;

export function capFindings(findings: Finding[], limit = FINDINGS_LIMIT): { findings: Finding[]; omitted: Record<Severity, number> } {
  const omitted: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  if (findings.length <= limit) return { findings, omitted };
  const ranked = sortFindings(findings);
  for (const finding of ranked.slice(limit)) omitted[finding.severity] += 1;
  return { findings: ranked.slice(0, limit), omitted };
}

export function omittedFindingsNote(omitted: Record<Severity, number>): string | null {
  const parts = (Object.entries(omitted) as Array<[Severity, number]>)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);
  if (!parts.length) return null;
  return `Findings are capped at ${FINDINGS_LIMIT}, most severe first; ${parts.join(', ')} finding(s) are not listed. Counts in "summary" cover all of them. Narrow the window or fix the listed items and re-run to see the rest.`;
}

export const AUDIENCE_COVERAGE_LIMIT = 40;

export function trimAudienceCoverage(
  coverage: Array<Record<string, unknown>>,
  limit = AUDIENCE_COVERAGE_LIMIT,
): { coverage: Array<Record<string, unknown>>; omitted: number } {
  if (coverage.length <= limit) return { coverage, omitted: 0 };
  const ranked = [...coverage].sort((a, b) => Number(b.enabled_campaigns ?? 0) - Number(a.enabled_campaigns ?? 0));
  return { coverage: ranked.slice(0, limit), omitted: coverage.length - limit };
}

function displayTask(title: string, reason: string, context: string): SuggestedTask {
  return {
    title,
    intent: 'google_ads_display_remarketing_diagnostics',
    suggested_workflow: 'google-ads/display-youtube-demandgen-remarketing.md',
    source_type: 'review',
    reason,
    context,
  };
}

export function analyzeDisplayRemarketing(
  input: {
    campaigns: DisplayCampaignRow[];
    adGroups: DisplayAdGroupRow[];
    audiences: DisplayAudienceRow[];
    userLists: UserListRow[];
  },
  windowDays: number,
  t = DISPLAY_REMARKETING_DEFAULTS,
): { findings: Finding[]; audience_coverage: Array<Record<string, unknown>> } {
  const findings: Finding[] = [];
  const listsByResourceName = new Map<string, UserListRow['user_list']>();
  for (const row of input.userLists) {
    const resourceName = row.user_list?.resource_name;
    if (resourceName) listsByResourceName.set(String(resourceName), row.user_list);
  }

  const audiencesByCampaign = new Map<string, DisplayAudienceRow[]>();
  for (const row of input.audiences) {
    const campaignId = String(row.campaign?.id ?? '');
    if (!campaignId) continue;
    const bucket = audiencesByCampaign.get(campaignId) ?? [];
    bucket.push(row);
    audiencesByCampaign.set(campaignId, bucket);
  }

  const audience_coverage: Array<Record<string, unknown>> = [];
  const listUsage = new Map<string, {
    list: UserListRow['user_list'];
    resourceName: string;
    campaigns: Array<{ id: string; name: string; enabled: boolean }>;
  }>();

  for (const row of input.campaigns) {
    const campaignId = String(row.campaign?.id ?? '');
    const name = row.campaign?.name ?? (campaignId || 'unknown');
    const entity = `campaign ${name}`;
    const status = enumLabel(enums.CampaignStatus as EnumTable, row.campaign?.status);
    const servingStatus = enumLabel(enums.CampaignServingStatus as EnumTable, row.campaign?.serving_status);
    const strategy = enumLabel(enums.BiddingStrategyType as EnumTable, row.campaign?.bidding_strategy_type);
    const impressions = Number(row.metrics?.impressions ?? 0);
    const dailyBudget = toUnits(row.campaign_budget?.amount_micros);
    const campaignAudiences = audiencesByCampaign.get(campaignId) ?? [];

    if (status === 'ENABLED' && servingStatus && !SERVING_STATUSES_OK.has(servingStatus)) {
      findings.push({
        code: 'campaign_not_serving',
        severity: 'critical',
        entity,
        observation: `Campaign is ENABLED but serving_status is ${servingStatus} — delivery is blocked upstream of bids and audiences.`,
        metrics: { serving_status: servingStatus, impressions, daily_budget: dailyBudget },
        suggested_task: displayTask(`Fix serving status on ${name}`, 'Enabled Display campaign is not eligible to serve.', `campaign_id=${campaignId}; serving_status=${servingStatus}`),
        prepare_actions: [],
      });
    }

    if (status === 'ENABLED' && !campaignAudiences.length) {
      findings.push({
        code: 'no_audience_attached',
        severity: 'critical',
        entity,
        observation: 'Enabled Display campaign has no user-list criteria on any ad group — a remarketing campaign without an audience cannot serve to past visitors.',
        metrics: { impressions, daily_budget: dailyBudget },
        suggested_task: displayTask(`Attach a remarketing audience to ${name}`, 'Display remarketing campaign has no user list attached.', `campaign_id=${campaignId}`),
        prepare_actions: [],
      });
    }

    if (status === 'ENABLED' && dailyBudget >= t.minDailyBudgetUnits && impressions === 0) {
      findings.push({
        code: 'zero_impressions',
        severity: 'critical',
        entity,
        observation: `Enabled campaign with ${dailyBudget} daily budget served 0 impressions over ${windowDays}d — check audience size, serving status and ad approval before touching bids.`,
        metrics: { impressions, daily_budget: dailyBudget, window_days: windowDays },
        suggested_task: displayTask(`Diagnose zero-impression Display campaign: ${name}`, 'Enabled Display campaign with a budget is not serving at all.', `campaign_id=${campaignId}; daily_budget=${dailyBudget}; window_days=${windowDays}`),
        prepare_actions: [],
      });
    }

    const seenLists = new Set<string>();
    for (const audienceRow of campaignAudiences) {
      const resourceName = audienceRow.ad_group_criterion?.user_list?.user_list;
      if (!resourceName || seenLists.has(String(resourceName))) continue;
      seenLists.add(String(resourceName));
      const key = String(resourceName);
      const usage = listUsage.get(key) ?? {
        list: listsByResourceName.get(key),
        resourceName: key,
        campaigns: [],
      };
      usage.campaigns.push({ id: campaignId, name, enabled: status === 'ENABLED' });
      listUsage.set(key, usage);
    }

    const campaignAdGroups = input.adGroups.filter((adGroup) => String(adGroup.campaign?.id ?? '') === campaignId);
    for (const adGroup of campaignAdGroups) {
      const adGroupName = adGroup.ad_group?.name ?? String(adGroup.ad_group?.id ?? 'unknown');
      const adGroupEntity = `ad group ${adGroupName} (${name})`;
      const cpc = toUnits(adGroup.ad_group?.cpc_bid_micros);
      const adGroupStatus = enumLabel(enums.AdGroupStatus as EnumTable, adGroup.ad_group?.status);

      if (status === 'ENABLED' && adGroupStatus === 'PAUSED') {
        findings.push({
          code: 'ad_group_paused_in_enabled_campaign',
          severity: 'warning',
          entity: adGroupEntity,
          observation: 'Ad group is PAUSED inside an ENABLED campaign — nothing in it can serve.',
          metrics: { campaign_id: campaignId, ad_group_id: String(adGroup.ad_group?.id ?? '') },
          suggested_task: displayTask(`Decide status of paused ad group: ${adGroupName}`, 'Paused ad group inside an enabled Display campaign.', `campaign_id=${campaignId}; ad_group_id=${adGroup.ad_group?.id}`),
          prepare_actions: ['prepare_ad_group_update'],
        });
      }

      if (strategy === 'MANUAL_CPC' && cpc > 0 && cpc <= t.lowCpcUnits) {
        findings.push({
          code: 'manual_cpc_below_floor',
          severity: 'warning',
          entity: adGroupEntity,
          observation: `Manual CPC bid is ${cpc}, at or below ${t.lowCpcUnits} — low enough to lose most Display auctions. Raising it is a valid delivery test here because the campaign uses MANUAL_CPC.`,
          metrics: { cpc_bid: cpc, floor: t.lowCpcUnits, campaign_id: campaignId, ad_group_id: String(adGroup.ad_group?.id ?? '') },
          suggested_task: displayTask(`Test a higher CPC on ad group: ${adGroupName}`, 'Manual CPC bid is low enough to suppress Display delivery.', `campaign_id=${campaignId}; ad_group_id=${adGroup.ad_group?.id}; cpc_bid=${cpc}`),
          prepare_actions: ['prepare_ad_group_update'],
        });
      }
    }

    if (strategy && strategy !== 'MANUAL_CPC' && impressions === 0 && status === 'ENABLED') {
      findings.push({
        code: 'bids_not_the_constraint',
        severity: 'info',
        entity,
        observation: `Campaign uses ${strategy}, so ad group CPC bids are ignored by Google. Do not change bids to fix this delivery problem — look at audience size, serving status, ad approval and conversion signal instead.`,
        metrics: { bidding_strategy_type: strategy, impressions, campaign_id: campaignId },
        suggested_task: displayTask(`Diagnose non-bid delivery blocker on ${name}`, 'Automated bidding means CPC changes cannot fix zero delivery.', `campaign_id=${campaignId}; bidding_strategy_type=${strategy}`),
        prepare_actions: [],
      });
    }
  }

  for (const usage of listUsage.values()) {
    const list = usage.list;
    const listName = list?.name ?? usage.resourceName;
    const size = list?.size_for_display === undefined ? undefined : Number(list.size_for_display);
    const searchSize = list?.size_for_search === undefined ? undefined : Number(list.size_for_search);
    const membershipDays = list?.membership_life_span === undefined ? undefined : Number(list.membership_life_span);
    const liveCampaigns = usage.campaigns.filter((campaign) => campaign.enabled);
    const usedByLive = liveCampaigns.length > 0;
    const campaignNames = usage.campaigns.map((campaign) => campaign.name).join(', ');
    const campaignIds = usage.campaigns.map((campaign) => campaign.id).join(',');
    const scope = usedByLive ? '' : ' (every campaign using this list is paused, so nothing is being lost right now)';
    const entity = `user list ${listName}`;
    const usageMetrics = {
      campaigns: usage.campaigns.length,
      enabled_campaigns: liveCampaigns.length,
      campaign_ids: campaignIds,
    };

    audience_coverage.push({
      user_list: listName,
      campaigns: usage.campaigns.map((campaign) => campaign.name),
      enabled_campaigns: liveCampaigns.length,
      size_for_display: size ?? 'unknown',
      size_for_search: searchSize ?? 'unknown',
      eligible_for_display: list?.eligible_for_display ?? 'unknown',
      membership_life_span_days: membershipDays ?? 'unknown',
    });

    const displaySizeUnreported = size === 0 && list?.eligible_for_display !== false && (searchSize ?? 0) >= t.minDisplayListSize;

    if (displaySizeUnreported) {
      findings.push({
        code: 'display_size_not_reported',
        severity: 'info',
        entity,
        observation: `Google reports 0 users for Display but ${searchSize} for Search and still marks the list eligible for Display. The Display figure is not populated for this list type, so it is not evidence of a delivery blocker — do not conclude the audience is empty from it.`,
        metrics: { ...usageMetrics, size_for_display: 0, size_for_search: searchSize ?? 0 },
        suggested_task: displayTask(`Verify Display reach for list: ${listName}`, 'Display list size is not reported by the API; reach must be checked in the UI audience manager.', `user_list=${listName}; campaign_ids=${campaignIds}; size_for_search=${searchSize}`),
        prepare_actions: [],
      });
    } else if (size !== undefined && size < t.minDisplayListSize) {
      findings.push({
        code: 'audience_below_display_minimum',
        severity: usedByLive ? 'critical' : 'info',
        entity,
        observation: `List has ${size} users for Display, below the ~${t.minDisplayListSize} needed to serve — this blocks delivery regardless of bid or budget${scope}. Used by: ${campaignNames}.`,
        metrics: { ...usageMetrics, size_for_display: size, minimum: t.minDisplayListSize, size_for_search: searchSize ?? 0 },
        suggested_task: displayTask(`Grow or replace remarketing list: ${listName}`, 'Remarketing list is below the Display minimum size.', `user_list=${listName}; campaign_ids=${campaignIds}; size=${size}`),
        prepare_actions: [],
      });
    }

    if (list?.eligible_for_display === false) {
      findings.push({
        code: 'audience_not_eligible_for_display',
        severity: usedByLive ? 'critical' : 'info',
        entity,
        observation: `List is not eligible for Display — check the tag/source and membership rules; Display cannot serve to it${scope}. Used by: ${campaignNames}.`,
        metrics: usageMetrics,
        suggested_task: displayTask(`Restore Display eligibility for list: ${listName}`, 'Remarketing list is not eligible for the Display network.', `user_list=${listName}; campaign_ids=${campaignIds}`),
        prepare_actions: [],
      });
    }

    if (
      membershipDays !== undefined && membershipDays > 0 && membershipDays < t.shortMembershipDays
      && size !== undefined && size < t.minDisplayListSize * 10 && !displaySizeUnreported
    ) {
      findings.push({
        code: 'short_membership_window',
        severity: usedByLive ? 'warning' : 'info',
        entity,
        observation: `Membership lasts ${membershipDays}d on a list of ${size} users — the audience drains faster than it refills${scope}.`,
        metrics: { ...usageMetrics, membership_life_span_days: membershipDays, size_for_display: size },
        suggested_task: displayTask(`Review membership window on list: ${listName}`, 'Short membership duration keeps the remarketing list too small to serve.', `user_list=${listName}; campaign_ids=${campaignIds}; membership_days=${membershipDays}`),
        prepare_actions: [],
      });
    }
  }

  return { findings: sortFindings(findings), audience_coverage };
}
