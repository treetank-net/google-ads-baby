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
import { tableDocument, shapeSchemas, type Row } from './table.js';
import { flattenRow, shortenResourceName } from './format.js';
import { currencyUnitScale } from './amounts.js';

interface AmountContext {
  currency: string;
  scale: number;
}

async function amountContext(cfg: AdsConfig, customerId: string): Promise<AmountContext> {
  const currency = await getAccountCurrency(cfg, customerId);
  return { currency, scale: currencyUnitScale(currency) };
}

function thresholdNote(ctx: AmountContext): string[] {
  if (!ctx.currency) return ['account currency unreadable: cost thresholds applied as PLN-tuned units, verify amounts before acting'];
  if (ctx.scale === 1) return [];
  return [`cost thresholds scaled ${ctx.scale}x from PLN defaults to ${ctx.currency}`];
}

export function findingRows(findings: Finding[]): Row[] {
  return sortFindings(findings).map((f) => ({
    severity: f.severity,
    code: f.code,
    entity: f.entity,
    observation: f.observation,
    ...f.metrics,
    task: f.suggested_task.title,
    intent: f.suggested_task.intent,
    workflow: f.suggested_task.suggested_workflow,
    source_type: f.suggested_task.source_type,
    reason: f.suggested_task.reason,
    context: f.suggested_task.context,
    actions: f.prepare_actions.join(' ~ '),
  }));
}

function normalizeCoverage(rows: Array<Record<string, unknown>>): Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(flattenRow(row)).map(([k, v]) => [k, shortenResourceName(v) as Row[string]])));
}

const SECTION_LIMIT = 50;
const LIST_LIMIT = 30;

export interface ReportSpec {
  name: string;
  customerId: string;
  scope: string[];
  ctx: AmountContext;
  counts: Record<string, number>;
  findings: Finding[];
  sections?: Array<[string, Row[], string?]>;
  lists?: Array<[string, string[]]>;
  notes?: string[];
  page?: number;
  pageChars?: number;
}

export function renderReport(spec: ReportSpec): string {
  const severity = summarize(spec.findings);
  const counts = Object.entries({ ...spec.counts, ...severity }).map(([k, v]) => `${k}=${v}`).join(' ');
  const lists = (spec.lists ?? []).filter(([, items]) => items.length).map(([label, items]) => {
    const shown = items.slice(0, LIST_LIMIT).join(' ~ ');
    return `${label} (${items.length}): ${shown}${items.length > LIST_LIMIT ? ` ~ +${items.length - LIST_LIMIT} more` : ''}`;
  });
  const parts = [tableDocument({
    title: spec.name,
    scope: [`customer ${spec.customerId}`, ...spec.scope],
    currency: spec.ctx.currency || undefined,
    rows: findingRows(spec.findings),
    shape: { page: spec.page, page_chars: spec.pageChars },
    extraNotes: [counts, ...thresholdNote(spec.ctx), ...(spec.notes ?? []), ...lists],
  })];
  for (const [title, rows, order] of spec.sections ?? []) {
    if (!rows.length) continue;
    parts.push(tableDocument({ title, rows, defaultOrder: order, shape: { limit: SECTION_LIMIT } }));
  }
  return parts.join('\n\n');
}

function report(spec: ReportSpec) {
  return { content: [{ type: 'text' as const, text: renderReport(spec) }] };
}

export function registerAnalysisReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'get_account_hygiene_report',
    'Daily check: zero spend, low budget use, spend without conversions. Findings + prepare_* actions.',
    {
      customer_id: z.string(),
      days: analysisWindowSchema,
      page: shapeSchemas.page,
      page_chars: shapeSchemas.page_chars,
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
        return report({ name: 'account_hygiene', customerId: cid, scope: [`last ${windowDays}d`], ctx, counts: { campaigns_scanned: rows.length }, findings, page, pageChars: page_chars });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_budget_scaling_candidates',
    'Budget-limited SEARCH/SHOPPING campaigns worth scaling, with prepare_budget_change actions.',
    {
      customer_id: z.string(),
      days: analysisWindowSchema,
      page: shapeSchemas.page,
      page_chars: shapeSchemas.page_chars,
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
        return report({ name: 'budget_scaling_candidates', customerId: cid, scope: [`last ${windowDays}d`], ctx, counts: { campaigns_scanned: rows.length }, findings, page, pageChars: page_chars });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_search_terms_waste_candidates',
    'Search terms with spend and 0 conversions (bounce-backs excluded) as negative-keyword candidates.',
    {
      customer_id: z.string(),
      recent_days: z.enum(['14', '30']).default('30').describe('0-conversion window'),
      cross_check_days: z.enum(['60', '90']).default('90').describe('Bounce-back window'),
      page: shapeSchemas.page,
      page_chars: shapeSchemas.page_chars,
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
        return report({
          name: 'search_terms_waste',
          customerId: cid,
          scope: [`recent ${recent}d`, `cross-check ${cross}d`],
          ctx,
          counts: { terms_scanned: rows30.length },
          findings,
          lists: [['excluded bounce-backs', excluded_bounce_back]],
          page,
          pageChars: page_chars,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_display_remarketing_diagnostics',
    'Why a Display remarketing campaign is not serving: status, lists, audience size, bids. Use before changing bids.',
    {
      customer_id: z.string(),
      days: analysisWindowSchema,
      page: shapeSchemas.page,
      page_chars: shapeSchemas.page_chars,
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
        return report({
          name: 'display_remarketing_diagnostics',
          customerId: cid,
          scope: [`last ${windowDays}d`],
          ctx,
          counts: { campaigns_scanned: campaigns.length, ad_groups_scanned: adGroups.length, user_lists_attached: audience_coverage.length },
          findings,
          sections: [['audience coverage', normalizeCoverage(ranked)]],
          notes: notChecked.length ? [`not checked: ${notChecked.join('; ')}`] : [],
          page,
          pageChars: page_chars,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_pmax_channel_breakdown',
    'Performance Max cost and conversions per asset group, flagging spend without conversions.',
    {
      customer_id: z.string(),
      days: analysisWindowSchema,
      page: shapeSchemas.page,
      page_chars: shapeSchemas.page_chars,
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
        return report({
          name: 'pmax_channel_breakdown',
          customerId: cid,
          scope: [`last ${windowDays}d`],
          ctx,
          counts: { asset_groups_scanned: rows.length },
          findings,
          sections: [['asset group breakdown', breakdown as unknown as Row[], '-cost']],
          page,
          pageChars: page_chars,
        });
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );
}

export type { Finding };
