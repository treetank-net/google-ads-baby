import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { listAccounts, executeGaql, getCampaigns } from '../client.js';
import { formatError } from '../errors.js';
import { normalizeCustomerId, requireCustomerId } from '../validation.js';
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
} from './read-helpers.js';

export function registerAccountReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'list_accounts',
    'List all Google Ads accounts under the MCC',
    {},
    async () => {
      if (!cfg.developerToken || !cfg.loginCustomerId) {
        return { content: [{ type: 'text', text: 'Error: Missing developer token or MCC ID. Run setup_google_auth first.' }] };
      }
      try {
        const accounts = await listAccounts(cfg);
        return { content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_campaigns',
    'Get campaigns with performance metrics for a specific account',
    {
      customer_id: z.string().describe('Google Ads customer ID (e.g. "1234567890")'),
      days: z.enum(['7', '30']).default('30').describe('Lookback period'),
    },
    async ({ customer_id, days }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const rows = await getCampaigns(cfg, normalizeCustomerId(customer_id), Number(days) as 7 | 30);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'execute_gaql',
    'Run an arbitrary GAQL query against a Google Ads account (read-only)',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      query: z.string().describe('GAQL query (SELECT ... FROM ... WHERE ...)'),
    },
    async ({ customer_id, query }) => {
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
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'list_ads_entities',
    'List Google Ads entities with optional filters and relationship context. Use this instead of broad account inspection on large accounts.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      entity: entitySchema.describe('What to list: campaigns, ad_groups, ads, assets, or ad_asset_links'),
      campaign_id: z.string().optional().describe('Optional campaign ID filter'),
      ad_group_id: z.string().optional().describe('Optional ad group ID filter'),
      status: upperTokenSchema.optional().describe('Optional status filter, e.g. ENABLED, PAUSED, REMOVED. For ad_asset_links use TRUE or FALSE to filter enabled links.'),
      type: upperTokenSchema.optional().describe('Optional entity type filter, e.g. SEARCH, DISPLAY, RESPONSIVE_SEARCH_AD, IMAGE'),
      subtype: upperTokenSchema.optional().describe('Optional campaign advertising channel subtype filter, e.g. DISPLAY_GMAIL_AD, SEARCH_MOBILE_APP'),
      name_contains: z.string().min(1).max(120).optional().describe('Optional case-sensitive name substring filter where the selected entity has a name'),
      limit: z.number().int().min(1).max(200).default(50).describe('Maximum rows to return, capped at 200'),
    },
    async (input) => {
      const validationError = requireCustomerId(input.customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const query = buildListQuery(input);
        const rows = await executeGaql(cfg, normalizeCustomerId(input.customer_id), query);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              entity: input.entity,
              limit: normalizeLimit(input.limit),
              rows,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_ad_blueprint',
    'Get one ad with campaign/ad group context, linked assets, and a clone-ready input shape for supported ad types.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      ad_id: z.string().optional().describe('Ad ID. Use this or ad_group_ad_resource_name.'),
      ad_group_ad_resource_name: z.string().optional().describe('Full ad group ad resource name, e.g. customers/123/adGroupAds/456~789. Use this when available.'),
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
