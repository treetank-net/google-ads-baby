import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { listAccounts, executeGaql } from '../client.js';
import { formatError } from '../errors.js';
import { normalizeCustomerId, requireCustomerId } from '../validation.js';
import { tsvDocument, paginate, pageNote } from './format.js';
import {
  entitySchema,
  upperTokenSchema,
  adFilter,
  normalizeLimit,
  resourceNameLiteral,
  buildAdBlueprint,
  buildAdQuery,
  buildAdAssetQuery,
  buildListQuery,
  buildCampaignStructureQuery,
  buildCampaignMetricsQuery,
  mergeCampaignMetrics,
  pageSchema,
  pageCharsSchema,
} from './read-helpers.js';

export function registerAccountReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'list_accounts',
    'List accessible Google Ads accounts with their currency.',
    {
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ page, page_chars }) => {
      if (!cfg.developerToken || !cfg.loginCustomerId) {
        return { content: [{ type: 'text', text: 'Error: Missing developer token or MCC ID. Run setup_google_auth first.' }] };
      }
      try {
        const accounts = await listAccounts(cfg);
        const slice = paginate(accounts as unknown[], page ?? 1, page_chars);
        const note = pageNote(slice, 'accounts');
        return { content: [{ type: 'text', text: tsvDocument([['accounts', slice.rows]], note ? [note] : []) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_campaigns',
    'Campaigns with performance metrics, including zero-activity ones (REMOVED excluded).',
    {
      customer_id: z.string(),
      days: z.enum(['7', '30']).default('30'),
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ customer_id, days, page, page_chars }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const cid = normalizeCustomerId(customer_id);
        const [structureRows, metricRows] = await Promise.all([
          executeGaql(cfg, cid, buildCampaignStructureQuery()),
          executeGaql(cfg, cid, buildCampaignMetricsQuery(Number(days) as 7 | 30)),
        ]);
        const rows = mergeCampaignMetrics(structureRows as any[], metricRows as any[]);
        const slice = paginate(rows as unknown[], page ?? 1, page_chars);
        const note = pageNote(slice, 'campaigns');
        const header = [`# campaigns for customer ${cid}, last ${days}d`, ...(note ? [note] : [])];
        return { content: [{ type: 'text', text: tsvDocument([['campaigns', slice.rows]], header) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'execute_gaql',
    'Run a read-only GAQL query. The gaql skill covers syntax pitfalls.',
    {
      customer_id: z.string(),
      query: z.string(),
      format: z.enum(['tsv', 'json']).default('tsv').describe('tsv (default) or json (raw rows, several times larger)'),
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async ({ customer_id, query, format, page, page_chars }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      if (/\b(CREATE|UPDATE|REMOVE|MUTATE)\b/i.test(query)) {
        return {
          content: [{ type: 'text', text: 'Error: GAQL mutations not allowed. Use prepare_* tools.' }],
        };
      }
      try {
        const rows = await executeGaql(cfg, normalizeCustomerId(customer_id), query);
        if (format === 'json') return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
        const slice = paginate(rows as unknown[], page ?? 1, page_chars);
        const note = pageNote(slice, 'rows');
        return { content: [{ type: 'text', text: tsvDocument([['rows', slice.rows]], note ? [note] : []) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_build_context',
    'One call before building: campaigns, ad groups, enabled conversion actions, reusable image assets.',
    {
      customer_id: z.string(),
    },
    async ({ customer_id }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const cid = normalizeCustomerId(customer_id);
        const [campaignRows, adGroupRows, conversionRows, assetRows] = await Promise.all([
          executeGaql(cfg, cid, `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status, campaign.bidding_strategy_type, campaign_budget.id, campaign_budget.amount_micros FROM campaign WHERE campaign.status IN ('ENABLED','PAUSED') ORDER BY campaign.id LIMIT 200`) as Promise<any[]>,
          executeGaql(cfg, cid, `SELECT ad_group.id, ad_group.name, ad_group.campaign, ad_group.status FROM ad_group WHERE ad_group.status IN ('ENABLED','PAUSED') LIMIT 500`) as Promise<any[]>,
          executeGaql(cfg, cid, `SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.status FROM conversion_action WHERE conversion_action.status = 'ENABLED' LIMIT 100`) as Promise<any[]>,
          executeGaql(cfg, cid, `SELECT asset.id, asset.name, asset.type FROM asset WHERE asset.type = 'IMAGE' LIMIT 50`) as Promise<any[]>,
        ]);
        const document = tsvDocument(
          [
            ['campaigns', campaignRows.map((r) => ({
              id: r.campaign?.id,
              name: r.campaign?.name,
              'campaign.advertising_channel_type': r.campaign?.advertising_channel_type,
              'campaign.status': r.campaign?.status,
              'campaign.bidding_strategy_type': r.campaign?.bidding_strategy_type,
              budget_id: r.campaign_budget?.id,
              budget_amount_micros: r.campaign_budget?.amount_micros,
            }))],
            ['ad_groups', adGroupRows.map((r) => ({
              id: r.ad_group?.id,
              name: r.ad_group?.name,
              campaign_id: r.ad_group?.campaign,
              'ad_group.status': r.ad_group?.status,
            }))],
            ['conversion_actions', conversionRows.map((r) => ({
              id: r.conversion_action?.id,
              name: r.conversion_action?.name,
              'conversion_action.category': r.conversion_action?.category,
            }))],
            ['image_assets', assetRows.map((r) => ({
              id: r.asset?.id,
              name: r.asset?.name,
              'asset.type': r.asset?.type,
            }))],
          ],
          [`# build context for customer ${cid}`],
        );
        return { content: [{ type: 'text', text: document }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'list_ads_entities',
    'List campaigns, ad groups, ads, keywords, negatives, assets or ad-asset links, with filters. No metrics.',
    {
      customer_id: z.string(),
      entity: entitySchema.describe('negative_keywords are campaign-level unless ad_group_id is given'),
      campaign_id: z.string().optional(),
      ad_group_id: z.string().optional(),
      status: upperTokenSchema.optional().describe('e.g. ENABLED, PAUSED; TRUE/FALSE for ad_asset_links'),
      type: upperTokenSchema.optional().describe('Channel, ad or asset type; match type for keywords'),
      subtype: upperTokenSchema.optional().describe('Channel subtype, e.g. DISPLAY_GMAIL_AD'),
      name_contains: z.string().min(1).max(120).optional().describe('Case-sensitive substring of the name or keyword text'),
      limit: z.number().int().min(1).max(5000).default(2000).describe('API fetch cap (default 2000, max 5000)'),
      page: pageSchema,
      page_chars: pageCharsSchema,
    },
    async (input) => {
      const validationError = requireCustomerId(input.customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const query = buildListQuery(input);
        const rows = await executeGaql(cfg, normalizeCustomerId(input.customer_id), query);
        const limit = normalizeLimit(input.limit);
        const list = rows as unknown[];
        const atFetchBound = list.length >= limit
          ? [`Fetched ${list.length} row(s) at the API bound of ${limit}; the account may hold more. Narrow with campaign_id / ad_group_id / status / name_contains, or raise limit (max 5000).`]
          : [];
        const slice = paginate(list, input.page ?? 1, input.page_chars);
        const note = pageNote(slice, input.entity);
        return {
          content: [{
            type: 'text',
            text: tsvDocument([[input.entity, slice.rows]], [
              `# ${input.entity} for customer ${normalizeCustomerId(input.customer_id)}`,
              ...atFetchBound,
              ...(note ? [note] : []),
            ]),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_ad_blueprint',
    'One ad with its context, linked assets and a clone-ready input.',
    {
      customer_id: z.string(),
      ad_id: z.string().optional().describe('Or ad_group_ad_resource_name'),
      ad_group_ad_resource_name: z.string().optional().describe('Preferred, e.g. customers/1/adGroupAds/2~3'),
    },
    async (input) => {
      const validationError = requireCustomerId(input.customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      const filter = adFilter(input);
      if (!filter) {
        return { content: [{ type: 'text', text: 'Error: Provide ad_id or ad_group_ad_resource_name.' }] };
      }
      try {
        const customerId = normalizeCustomerId(input.customer_id);
        const adRows = await executeGaql(cfg, customerId, buildAdQuery(filter)) as any[];
        if (adRows.length === 0) {
          return { content: [{ type: 'text', text: 'Error: Ad not found for the provided ID/resource name.' }] };
        }
        if (adRows.length > 1) {
          return { content: [{ type: 'text', text: 'Error: More than one ad matched. Retry with ad_group_ad_resource_name.' }] };
        }
        const resourceFilter = `ad_group_ad.resource_name = ${resourceNameLiteral(adRows[0].ad_group_ad.resource_name)}`;
        const assetRows = await executeGaql(cfg, customerId, buildAdAssetQuery(resourceFilter)) as any[];
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(buildAdBlueprint(adRows[0], assetRows), null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );
}
