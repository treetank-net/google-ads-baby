import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { listAccounts, executeGaql, getAccountCurrency } from '../client.js';
import { formatError } from '../errors.js';
import { normalizeCustomerId, requireCustomerId } from '../validation.js';
import { tsvDocument, paginate, pageNote, decodeEnumsDeep } from './format.js';
import { normalizeRows, tableDocument, tableError, shapeSchemas, MAX_TABLE_PAGE_CHARS } from './table.js';
import {
  entitySchema,
  upperTokenSchema,
  adFilter,
  MAX_FETCH_LIMIT,
  FILE_FETCH_LIMIT,
  resourceNameLiteral,
  buildAdBlueprint,
  buildAdQuery,
  buildAdAssetQuery,
  buildListQuery,
  buildCampaignStructureQuery,
  buildCampaignMetricsQuery,
  mergeCampaignMetrics,
} from './read-helpers.js';

export function registerAccountReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'list_accounts',
    'List accessible Google Ads accounts with their currency.',
    {
      page: shapeSchemas.page,
      page_chars: shapeSchemas.page_chars,
    },
    async ({ page, page_chars }) => {
      if (!cfg.developerToken || !cfg.loginCustomerId) {
        return { content: [{ type: 'text', text: 'Error: Missing developer token or MCC ID. Run setup_google_auth first.' }] };
      }
      try {
        const accounts = await listAccounts(cfg);
        return { content: [{ type: 'text', text: tableDocument({ title: 'accounts', rows: normalizeRows(accounts), shape: { page, page_chars } }) }] };
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
      ...shapeSchemas,
    },
    async ({ customer_id, days, ...shape }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const cid = normalizeCustomerId(customer_id);
        const [structureRows, metricRows, currency] = await Promise.all([
          executeGaql(cfg, cid, buildCampaignStructureQuery()),
          executeGaql(cfg, cid, buildCampaignMetricsQuery(Number(days) as 7 | 30)),
          getAccountCurrency(cfg, cid),
        ]);
        const rows = normalizeRows(mergeCampaignMetrics(structureRows as any[], metricRows as any[]));
        const text = tableDocument({ title: 'campaigns', scope: [`customer ${cid}`, `last ${days}d`], currency, rows, shape, defaultOrder: '-cost' });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: tableError(err) ?? formatError(err) }] };
      }
    },
  );

  server.tool(
    'execute_gaql',
    'Run a read-only GAQL query. The gaql skill covers syntax pitfalls.',
    {
      customer_id: z.string(),
      query: z.string(),
      format: z.enum(['tsv', 'json']).default('tsv').describe('json only when nested structures matter'),
      ...shapeSchemas,
    },
    async ({ customer_id, query, format, ...shape }) => {
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
        const cid = normalizeCustomerId(customer_id);
        const [rows, currency] = await Promise.all([executeGaql(cfg, cid, query), getAccountCurrency(cfg, cid)]);
        if (format === 'json' && shape.output !== 'file') {
          const decoded = (rows as unknown[]).map((row) => decodeEnumsDeep(row));
          const slice = paginate(decoded, shape.page ?? 1, Math.min(shape.page_chars ?? 12_000, MAX_TABLE_PAGE_CHARS), (page) => JSON.stringify(page));
          const note = pageNote(slice, 'rows');
          return { content: [{ type: 'text', text: [...(note ? [note] : []), JSON.stringify(slice.rows)].join('\n') }] };
        }
        const text = tableDocument({ title: 'gaql', scope: [`customer ${cid}`], currency, rows: normalizeRows(rows as unknown[]), shape });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: tableError(err) ?? formatError(err) }] };
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
          executeGaql(cfg, cid, `SELECT conversion_action.id, conversion_action.name, conversion_action.category FROM conversion_action WHERE conversion_action.status = 'ENABLED' LIMIT 100`) as Promise<any[]>,
          executeGaql(cfg, cid, `SELECT asset.id, asset.name, asset.type FROM asset WHERE asset.type = 'IMAGE' LIMIT 50`) as Promise<any[]>,
        ]);
        const currency = await getAccountCurrency(cfg, cid);
        const section = (title: string, rows: any[], cap: number, hint: string) => tableDocument({
          title,
          rows: normalizeRows(rows),
          ...(title === 'campaigns' ? { currency } : {}),
          extraNotes: rows.length >= cap ? [`capped at ${cap}; ${hint}`] : [],
        });
        const document = [
          `# build context · customer ${cid}`,
          section('campaigns', campaignRows, 200, 'list_ads_entities(campaigns) lists all'),
          section('ad_groups', adGroupRows, 500, 'list_ads_entities(ad_groups) lists all'),
          section('conversion_actions', conversionRows, 100, 'execute_gaql on conversion_action lists all'),
          section('image_assets', assetRows, 50, 'list_ads_entities(assets, type IMAGE) lists all'),
        ].join('\n\n');
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
      fields: shapeSchemas.fields,
      order_by: shapeSchemas.order_by,
      limit: shapeSchemas.limit,
      page: shapeSchemas.page,
      page_chars: shapeSchemas.page_chars,
      output: shapeSchemas.output,
    },
    async ({ fields, order_by, limit, page, page_chars, output, ...input }) => {
      const validationError = requireCustomerId(input.customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const cid = normalizeCustomerId(input.customer_id);
        const fetchLimit = output === 'file' ? FILE_FETCH_LIMIT : MAX_FETCH_LIMIT;
        const rows = await executeGaql(cfg, cid, buildListQuery({ ...input, limit: fetchLimit }, fetchLimit)) as unknown[];
        const needsCurrency = input.entity === 'ad_groups' || input.entity === 'keywords';
        const currency = needsCurrency ? await getAccountCurrency(cfg, cid) : undefined;
        const text = tableDocument({
          title: input.entity,
          scope: [`customer ${cid}`],
          currency,
          rows: normalizeRows(rows),
          shape: { fields, order_by, limit, page, page_chars, output },
          extraNotes: rows.length >= fetchLimit ? [`capped at ${fetchLimit} rows; narrow with campaign_id, ad_group_id, status or name_contains`] : [],
        });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: tableError(err) ?? formatError(err) }] };
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
            text: JSON.stringify(buildAdBlueprint(adRows[0], assetRows)),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );
}
