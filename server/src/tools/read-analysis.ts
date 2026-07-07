import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { executeGaql } from '../client.js';
import { formatError } from '../errors.js';
import { normalizeCustomerId, requireCustomerId } from '../validation.js';
import {
  analysisWindowSchema,
  analyzeAccountHygiene,
  analyzePmaxBreakdown,
  analyzeScalingCandidates,
  analyzeSearchTermsWaste,
  buildHygieneQuery,
  buildPmaxQuery,
  buildScalingQuery,
  buildSearchTermsQuery,
  summarize,
  windowClause,
  type Finding,
  type HygieneRow,
  type PmaxAssetGroupRow,
  type ScalingRow,
  type SearchTermRow,
} from './analysis-helpers.js';

function report(name: string, customerId: string, extra: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ report: name, customer_id: customerId, ...extra }, null, 2) }] };
}

const followUp =
  'Each finding carries a suggested_task and prepare_actions. Record the ones you act on with append_task ' +
  '(marketing-context, source_type: review) so they enter the backlog; mutations stay behind prepare_*/confirm.';

export function registerAnalysisReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'get_account_hygiene_report',
    'Read-only daily-check analysis for one account: scans enabled campaigns over a window and flags zero-spend, ' +
      'low budget utilization, and spend-with-no-conversions per the google-ads-daily-check workflow. Returns findings ' +
      'with severity, metrics, a suggested follow-up task, and possible prepare_* actions. Does not mutate anything.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      days: analysisWindowSchema.describe('Lookback window in days (7/14/30)'),
    },
    async ({ customer_id, days }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const windowDays = Number(days);
        const rows = (await executeGaql(cfg, cid, buildHygieneQuery(windowClause(windowDays)))) as HygieneRow[];
        const findings = analyzeAccountHygiene(rows, windowDays);
        return report('account_hygiene', cid, {
          window_days: windowDays,
          campaigns_scanned: rows.length,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_budget_scaling_candidates',
    'Read-only scan for budget-constrained SEARCH/SHOPPING campaigns: high budget utilization (>= 90%) together with ' +
      'search impression share lost to budget (> 10%), per the google-ads-monthly-review workflow. Returns scaling ' +
      'candidates with ROAS/util/IS context, a suggested task pointing at the budget-scaling workflow, and ' +
      'prepare_budget_change as the possible action. Does not mutate anything.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      days: analysisWindowSchema.describe('Lookback window in days (7/14/30)'),
    },
    async ({ customer_id, days }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const windowDays = Number(days);
        const rows = (await executeGaql(cfg, cid, buildScalingQuery(windowClause(windowDays)))) as ScalingRow[];
        const findings = analyzeScalingCandidates(rows, windowDays);
        return report('budget_scaling_candidates', cid, {
          window_days: windowDays,
          campaigns_scanned: rows.length,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_search_terms_waste_candidates',
    'Read-only negative-keyword scan: search terms with cost >= threshold and 0 conversions in the recent window, ' +
      'cross-checked against a longer window so historically-converting terms (bounce-backs) are excluded, per the ' +
      'google-ads-monthly-review workflow. Returns negative-keyword candidates with a suggested task and ' +
      'prepare_negative_keywords as the possible action. Does not mutate anything.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      recent_days: z.enum(['14', '30']).default('30').describe('Recent window for the 0-conversion test'),
      cross_check_days: z.enum(['60', '90']).default('90').describe('Longer window for the bounce-back cross-check'),
    },
    async ({ customer_id, recent_days, cross_check_days }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const recent = Number(recent_days);
        const cross = Number(cross_check_days);
        const [rows30, rows90] = await Promise.all([
          executeGaql(cfg, cid, buildSearchTermsQuery(windowClause(recent))) as Promise<SearchTermRow[]>,
          executeGaql(cfg, cid, buildSearchTermsQuery(windowClause(cross))) as Promise<SearchTermRow[]>,
        ]);
        const { findings, excluded_bounce_back } = analyzeSearchTermsWaste(rows30, rows90);
        return report('search_terms_waste', cid, {
          recent_days: recent,
          cross_check_days: cross,
          terms_scanned: rows30.length,
          excluded_bounce_back,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_pmax_channel_breakdown',
    'Read-only Performance Max analysis: cost/conversions per asset group with each group\'s share of its campaign ' +
      'spend, flagging asset groups burning budget with 0 conversions. Note: Google Ads does not expose a clean ' +
      'per-channel (Shopping vs Display vs Search) split for PMax via GAQL, so this reports the asset-group level; ' +
      'the finer feed-only-leak check from the workflow still needs the manual PMax placement report. Does not mutate.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      days: analysisWindowSchema.describe('Lookback window in days (7/14/30)'),
    },
    async ({ customer_id, days }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const windowDays = Number(days);
        const rows = (await executeGaql(cfg, cid, buildPmaxQuery(windowClause(windowDays)))) as PmaxAssetGroupRow[];
        const { findings, breakdown } = analyzePmaxBreakdown(rows);
        return report('pmax_channel_breakdown', cid, {
          window_days: windowDays,
          asset_groups_scanned: rows.length,
          breakdown,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );
}

export type { Finding };
