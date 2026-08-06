import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { executeGaql, getAccountCurrency } from '../client.js';
import { formatError } from '../errors.js';
import { normalizeCustomerId, requireCustomerId } from '../validation.js';
import {
  analysisWindowSchema,
  analyzeAccountHygiene,
  analyzePmaxBreakdown,
  analyzeScalingCandidates,
  analyzeSearchTermsWaste,
  analyzeDisplayRemarketing,
  rankAudienceCoverage,
  sortFindings,
  buildHygieneQuery,
  buildPmaxQuery,
  buildScalingQuery,
  buildSearchTermsQuery,
  buildDisplayCampaignQuery,
  buildDisplayAdGroupQuery,
  buildDisplayAudienceQuery,
  buildUserListQuery,
  summarize,
  windowClause,
  scaleUnitThresholds,
  HYGIENE_DEFAULTS,
  WASTE_DEFAULTS,
  PMAX_DEFAULTS,
  DISPLAY_REMARKETING_DEFAULTS,
  type Finding,
  type HygieneRow,
  type PmaxAssetGroupRow,
  type ScalingRow,
  type SearchTermRow,
  type DisplayCampaignRow,
  type DisplayAdGroupRow,
  type DisplayAudienceRow,
  type UserListRow,
} from './analysis-helpers.js';
import { pageSchema, pageCharsSchema } from './read-helpers.js';
import { currencyUnitScale } from './amounts.js';
import { toTsv, paginate, pageNote } from './format.js';

const renderFindings = (rows: Finding[]) => JSON.stringify(rows, null, 2);

interface AmountContext {
  currency: string;
  scale: number;
}

async function amountContext(cfg: AdsConfig, customerId: string): Promise<AmountContext> {
  const currency = await getAccountCurrency(cfg, customerId);
  return { currency, scale: currencyUnitScale(currency) };
}

function thresholdNote(ctx: AmountContext): Record<string, string> {
  if (!ctx.currency) {
    return { thresholds_note: 'The account currency could not be read, so cost thresholds are applied as raw account currency units tuned for PLN accounts. Verify the amounts before acting on them.' };
  }
  if (ctx.scale === 1) return {};
  return { thresholds_note: `Cost thresholds are scaled ${ctx.scale}x from their PLN defaults to match ${ctx.currency}. Every amount in this report is in ${ctx.currency}.` };
}

function report(name: string, customerId: string, extra: Record<string, unknown>, page?: number, pageChars?: number) {
  const body: Record<string, unknown> = { report: name, customer_id: customerId, ...extra };
  if (Array.isArray(body.findings)) {
    const ranked = sortFindings(body.findings as Finding[]);
    const slice = paginate(ranked, page ?? 1, pageChars, renderFindings);
    body.findings = slice.rows;
    const note = pageNote(slice, 'findings');
    if (note) body.findings_note = `${note} Findings are ordered most severe first, so page 1 carries the criticals. Counts in "summary" cover every finding, not just this page.`;
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
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
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ customer_id, days, page, page_chars }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const ctx = await amountContext(cfg, cid);
        const windowDays = Number(days);
        const rows = (await executeGaql(cfg, cid, buildHygieneQuery(windowClause(windowDays)))) as HygieneRow[];
        const findings = analyzeAccountHygiene(rows, windowDays, scaleUnitThresholds(HYGIENE_DEFAULTS, ctx.scale));
        return report('account_hygiene', cid, {
          window_days: windowDays,
          currency: ctx.currency,
          ...thresholdNote(ctx),
          campaigns_scanned: rows.length,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        }, page, page_chars);
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
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ customer_id, days, page, page_chars }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const ctx = await amountContext(cfg, cid);
        const windowDays = Number(days);
        const rows = (await executeGaql(cfg, cid, buildScalingQuery(windowClause(windowDays)))) as ScalingRow[];
        const findings = analyzeScalingCandidates(rows, windowDays);
        return report('budget_scaling_candidates', cid, {
          window_days: windowDays,
          currency: ctx.currency,
          campaigns_scanned: rows.length,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        }, page, page_chars);
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
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ customer_id, recent_days, cross_check_days, page, page_chars }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const ctx = await amountContext(cfg, cid);
        const recent = Number(recent_days);
        const cross = Number(cross_check_days);
        const [rows30, rows90] = await Promise.all([
          executeGaql(cfg, cid, buildSearchTermsQuery(windowClause(recent))) as Promise<SearchTermRow[]>,
          executeGaql(cfg, cid, buildSearchTermsQuery(windowClause(cross))) as Promise<SearchTermRow[]>,
        ]);
        const { findings, excluded_bounce_back } = analyzeSearchTermsWaste(rows30, rows90, scaleUnitThresholds(WASTE_DEFAULTS, ctx.scale));
        return report('search_terms_waste', cid, {
          recent_days: recent,
          currency: ctx.currency,
          ...thresholdNote(ctx),
          cross_check_days: cross,
          terms_scanned: rows30.length,
          excluded_bounce_back,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        }, page, page_chars);
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_display_remarketing_diagnostics',
    'Read-only delivery diagnostics for Display remarketing campaigns: checks serving status, whether any user list is ' +
      'attached, audience size against the ~100-user Display minimum, Display eligibility and membership duration of each ' +
      'list, paused ad groups inside enabled campaigns, and manual CPC bids low enough to suppress delivery. When the ' +
      'campaign uses automated bidding it says so explicitly, because then CPC changes cannot fix delivery. Use this ' +
      'before changing bids on a campaign that is not serving. Does not mutate anything.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      days: analysisWindowSchema.describe('Lookback window in days (7/14/30)'),
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ customer_id, days, page, page_chars }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const ctx = await amountContext(cfg, cid);
        const windowDays = Number(days);
        const notChecked: string[] = [];
        const fetchOptional = async <T>(label: string, query: string): Promise<T[]> => {
          try {
            return (await executeGaql(cfg, cid, query)) as T[];
          } catch (err) {
            notChecked.push(`${label} — ${formatError(err)}`);
            return [];
          }
        };
        const campaigns = (await executeGaql(cfg, cid, buildDisplayCampaignQuery(windowClause(windowDays)))) as DisplayCampaignRow[];
        const [adGroups, audiences, userLists] = await Promise.all([
          fetchOptional<DisplayAdGroupRow>('ad groups', buildDisplayAdGroupQuery()),
          fetchOptional<DisplayAudienceRow>('audience links', buildDisplayAudienceQuery()),
          fetchOptional<UserListRow>('user lists', buildUserListQuery()),
        ]);
        const { findings, audience_coverage } = analyzeDisplayRemarketing({ campaigns, adGroups, audiences, userLists }, windowDays, scaleUnitThresholds(DISPLAY_REMARKETING_DEFAULTS, ctx.scale));
        const ranked = rankAudienceCoverage(audience_coverage);
        const coveragePage = paginate(ranked, page ?? 1, page_chars);
        const coverageNote = pageNote(coveragePage, 'user lists');
        return report('display_remarketing_diagnostics', cid, {
          window_days: windowDays,
          currency: ctx.currency,
          ...thresholdNote(ctx),
          campaigns_scanned: campaigns.length,
          ad_groups_scanned: adGroups.length,
          user_lists_attached: audience_coverage.length,
          audience_coverage_tsv: toTsv(coveragePage.rows),
          ...(coverageNote
            ? { audience_coverage_note: `${coverageNote} Lists are ordered by how many enabled campaigns use them.` }
            : {}),
          summary: summarize(findings),
          findings,
          not_checked: notChecked,
          follow_up: followUp,
        }, page, page_chars);
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
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ customer_id, days, page, page_chars }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      try {
        const cid = normalizeCustomerId(customer_id);
        const ctx = await amountContext(cfg, cid);
        const windowDays = Number(days);
        const rows = (await executeGaql(cfg, cid, buildPmaxQuery(windowClause(windowDays)))) as PmaxAssetGroupRow[];
        const { findings, breakdown } = analyzePmaxBreakdown(rows, scaleUnitThresholds(PMAX_DEFAULTS, ctx.scale));
        return report('pmax_channel_breakdown', cid, {
          window_days: windowDays,
          currency: ctx.currency,
          ...thresholdNote(ctx),
          asset_groups_scanned: rows.length,
          breakdown,
          summary: summarize(findings),
          findings,
          follow_up: followUp,
        }, page, page_chars);
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );
}

export type { Finding };
