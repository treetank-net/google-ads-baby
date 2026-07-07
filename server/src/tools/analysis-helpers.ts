import { z } from 'zod';

export type Severity = 'critical' | 'warning' | 'info';

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
