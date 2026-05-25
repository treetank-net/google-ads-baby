import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { listAccounts, executeGaql, getCampaigns } from '../client.js';
import { formatError } from '../errors.js';
import { readHistory, getHistoryStats } from '../history.js';
import { normalizeCustomerId, normalizeResourceId, requireCustomerId } from '../validation.js';

const entitySchema = z.enum(['campaigns', 'ad_groups', 'ads', 'assets', 'ad_asset_links']);
const upperTokenSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Use a Google Ads enum value, e.g. ENABLED, PAUSED, SEARCH, RESPONSIVE_DISPLAY_AD');

type AdBlueprintInput = {
  customer_id: string;
  ad_id?: string;
  ad_group_ad_resource_name?: string;
};

function gaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(limit ?? 50), 200));
}

function resourceNameLiteral(value: string): string {
  return `'${gaqlString(value.trim())}'`;
}

function adFilter(input: AdBlueprintInput): string | null {
  if (input.ad_group_ad_resource_name?.trim()) {
    return `ad_group_ad.resource_name = ${resourceNameLiteral(input.ad_group_ad_resource_name)}`;
  }
  if (input.ad_id?.trim()) {
    return `ad_group_ad.ad.id = ${normalizeResourceId(input.ad_id)}`;
  }
  return null;
}

function assetIdFromResourceName(resourceName: string | undefined): string | null {
  const match = resourceName?.match(/\/assets\/(\d+)$/);
  return match ? match[1] : null;
}

function fieldNameFromAssetViewResourceName(resourceName: string | undefined): string | null {
  const match = resourceName?.match(/~([^~]+)$/);
  return match ? match[1] : null;
}

function textValues(items: Array<{ text?: string }> | undefined): string[] {
  return (items ?? []).map((item) => item.text).filter((value): value is string => Boolean(value));
}

function assetRefs(items: Array<{ asset?: string }> | undefined): string[] {
  return (items ?? []).map((item) => item.asset).filter((value): value is string => Boolean(value));
}

function buildAdBlueprint(adRow: any, assetRows: any[]) {
  const ad = adRow.ad_group_ad?.ad ?? {};
  const responsiveDisplay = ad.responsive_display_ad;
  const responsiveSearch = ad.responsive_search_ad;
  const typeHint = responsiveDisplay
    ? 'RESPONSIVE_DISPLAY_AD'
    : responsiveSearch
      ? 'RESPONSIVE_SEARCH_AD'
      : undefined;
  const assetsByField = assetRows.reduce<Record<string, unknown[]>>((grouped, row) => {
    const view = row.ad_group_ad_asset_view ?? {};
    const asset = row.asset ?? {};
    const field = fieldNameFromAssetViewResourceName(view.resource_name) ?? String(view.field_type ?? 'UNKNOWN');
    grouped[field] = grouped[field] ?? [];
    grouped[field].push({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      resource_name: asset.resource_name,
      text: asset.text_asset?.text,
      image: asset.image_asset ? {
        url: asset.image_asset.full_size?.url,
        width_pixels: asset.image_asset.full_size?.width_pixels,
        height_pixels: asset.image_asset.full_size?.height_pixels,
      } : undefined,
      enabled: view.enabled,
    });
    return grouped;
  }, {});

  const cloneInput = responsiveDisplay ? {
    tool: 'prepare_responsive_display_ad',
    ad_group_id: String(adRow.ad_group?.id ?? ''),
    business_name: responsiveDisplay.business_name,
    headlines: textValues(responsiveDisplay.headlines),
    long_headline: responsiveDisplay.long_headline?.text,
    descriptions: textValues(responsiveDisplay.descriptions),
    final_url: ad.final_urls?.[0],
    marketing_image_asset_ids: assetRefs(responsiveDisplay.marketing_images).map((name) => assetIdFromResourceName(name)).filter(Boolean),
    square_marketing_image_asset_ids: assetRefs(responsiveDisplay.square_marketing_images).map((name) => assetIdFromResourceName(name)).filter(Boolean),
    logo_image_asset_ids: assetRefs(responsiveDisplay.logo_images).map((name) => assetIdFromResourceName(name)).filter(Boolean),
  } : responsiveSearch ? {
    tool: 'prepare_responsive_search_ad',
    ad_group_id: String(adRow.ad_group?.id ?? ''),
    headlines: textValues(responsiveSearch.headlines),
    descriptions: textValues(responsiveSearch.descriptions),
    final_url: ad.final_urls?.[0],
  } : undefined;

  return {
    campaign: adRow.campaign,
    ad_group: adRow.ad_group,
    ad_group_ad: {
      resource_name: adRow.ad_group_ad?.resource_name,
      status: adRow.ad_group_ad?.status,
    },
    ad: {
      id: ad.id,
      resource_name: ad.resource_name,
      type: ad.type,
      type_hint: typeHint,
      final_urls: ad.final_urls,
      responsive_search_ad: responsiveSearch,
      responsive_display_ad: responsiveDisplay,
    },
    assets_by_field: assetsByField,
    clone_input: cloneInput,
  };
}

function buildAdQuery(filter: string) {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      ad_group_ad.resource_name,
      ad_group_ad.status,
      ad_group_ad.ad.id,
      ad_group_ad.ad.resource_name,
      ad_group_ad.ad.type,
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.responsive_display_ad.business_name,
      ad_group_ad.ad.responsive_display_ad.headlines,
      ad_group_ad.ad.responsive_display_ad.long_headline,
      ad_group_ad.ad.responsive_display_ad.descriptions,
      ad_group_ad.ad.responsive_display_ad.marketing_images,
      ad_group_ad.ad.responsive_display_ad.square_marketing_images,
      ad_group_ad.ad.responsive_display_ad.logo_images
    FROM ad_group_ad
    WHERE ${filter}
    LIMIT 2
  `;
}

function buildAdAssetQuery(filter: string) {
  return `
    SELECT
      ad_group_ad_asset_view.resource_name,
      ad_group_ad_asset_view.field_type,
      ad_group_ad_asset_view.enabled,
      asset.id,
      asset.name,
      asset.type,
      asset.resource_name,
      asset.image_asset.full_size.url,
      asset.image_asset.full_size.width_pixels,
      asset.image_asset.full_size.height_pixels,
      asset.text_asset.text
    FROM ad_group_ad_asset_view
    WHERE ${filter}
    ORDER BY ad_group_ad_asset_view.field_type, asset.id
    LIMIT 200
  `;
}

function addCommonFilters(filters: string[], input: {
  campaign_id?: string;
  ad_group_id?: string;
  status?: string;
  type?: string;
  subtype?: string;
  name_contains?: string;
}, names: {
  status?: string;
  type?: string;
  subtype?: string;
  name?: string;
}) {
  if (input.campaign_id) filters.push(`campaign.id = ${normalizeResourceId(input.campaign_id)}`);
  if (input.ad_group_id) filters.push(`ad_group.id = ${normalizeResourceId(input.ad_group_id)}`);
  if (input.status && names.status) filters.push(`${names.status} = '${input.status}'`);
  if (input.type && names.type) filters.push(`${names.type} = '${input.type}'`);
  if (input.subtype && names.subtype) filters.push(`${names.subtype} = '${input.subtype}'`);
  if (input.name_contains && names.name) filters.push(`${names.name} LIKE '%${gaqlString(input.name_contains)}%'`);
}

function buildListQuery(input: {
  entity: z.infer<typeof entitySchema>;
  campaign_id?: string;
  ad_group_id?: string;
  status?: string;
  type?: string;
  subtype?: string;
  name_contains?: string;
  limit?: number;
}) {
  const filters: string[] = [];
  const limit = normalizeLimit(input.limit);

  switch (input.entity) {
    case 'campaigns':
      addCommonFilters(filters, input, {
        status: 'campaign.status',
        type: 'campaign.advertising_channel_type',
        subtype: 'campaign.advertising_channel_sub_type',
        name: 'campaign.name',
      });
      return `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.advertising_channel_sub_type,
          campaign.serving_status,
          campaign.campaign_budget
        FROM campaign
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY campaign.name
        LIMIT ${limit}
      `;

    case 'ad_groups':
      addCommonFilters(filters, input, {
        status: 'ad_group.status',
        type: 'ad_group.type',
        subtype: 'campaign.advertising_channel_sub_type',
        name: 'ad_group.name',
      });
      return `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          ad_group.id,
          ad_group.name,
          ad_group.status,
          ad_group.type,
          ad_group.cpc_bid_micros
        FROM ad_group
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY campaign.name, ad_group.name
        LIMIT ${limit}
      `;

    case 'ads':
      addCommonFilters(filters, input, {
        status: 'ad_group_ad.status',
        type: 'ad_group_ad.ad.type',
        subtype: 'campaign.advertising_channel_sub_type',
      });
      return `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          ad_group.id,
          ad_group.name,
          ad_group.status,
          ad_group_ad.status,
          ad_group_ad.ad.id,
          ad_group_ad.ad.type,
          ad_group_ad.ad.final_urls,
          ad_group_ad.ad.responsive_search_ad.headlines,
          ad_group_ad.ad.responsive_search_ad.descriptions,
          ad_group_ad.ad.responsive_display_ad.business_name,
          ad_group_ad.ad.responsive_display_ad.headlines,
          ad_group_ad.ad.responsive_display_ad.long_headline,
          ad_group_ad.ad.responsive_display_ad.descriptions,
          ad_group_ad.ad.responsive_display_ad.marketing_images,
          ad_group_ad.ad.responsive_display_ad.square_marketing_images,
          ad_group_ad.ad.responsive_display_ad.logo_images
        FROM ad_group_ad
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY campaign.name, ad_group.name, ad_group_ad.ad.id
        LIMIT ${limit}
      `;

    case 'assets':
      if (input.type) filters.push(`asset.type = '${input.type}'`);
      if (input.name_contains) filters.push(`asset.name LIKE '%${gaqlString(input.name_contains)}%'`);
      return `
        SELECT
          asset.id,
          asset.name,
          asset.type,
          asset.resource_name,
          asset.image_asset.full_size.url,
          asset.image_asset.full_size.width_pixels,
          asset.image_asset.full_size.height_pixels,
          asset.image_asset.file_size,
          asset.image_asset.mime_type,
          asset.text_asset.text
        FROM asset
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY asset.name
        LIMIT ${limit}
      `;

    case 'ad_asset_links':
      addCommonFilters(filters, input, {
        type: 'asset.type',
        subtype: 'campaign.advertising_channel_sub_type',
      });
      if (input.status === 'TRUE' || input.status === 'FALSE') {
        filters.push(`ad_group_ad_asset_view.enabled = ${input.status.toLowerCase()}`);
      }
      if (input.name_contains) filters.push(`asset.name LIKE '%${gaqlString(input.name_contains)}%'`);
      return `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group_ad.ad.id,
          ad_group_ad.ad.type,
          ad_group_ad_asset_view.field_type,
          ad_group_ad_asset_view.enabled,
          asset.id,
          asset.name,
          asset.type,
          asset.resource_name,
          asset.image_asset.full_size.url,
          asset.image_asset.full_size.width_pixels,
          asset.image_asset.full_size.height_pixels,
          asset.text_asset.text
        FROM ad_group_ad_asset_view
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY campaign.name, ad_group.name, ad_group_ad.ad.id
        LIMIT ${limit}
      `;
  }
}

export function registerReadTools(server: McpServer, cfg: AdsConfig) {
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

  server.tool(
    'get_mutation_history',
    'Browse past mutation operations. Shows what was done, when, with what params (including asset IDs, image URLs, headlines, etc.). Use to replicate previous campaigns or find previously used assets/logos.',
    {
      customer_id: z.string().optional().describe('Filter by customer ID'),
      action: z.string().optional().describe('Filter by action type, e.g. search_campaign_create, campaign_extensions_batch, image_asset_upload_from_url'),
      since: z.string().optional().describe('ISO date/time lower bound, e.g. 2025-01-01'),
      until: z.string().optional().describe('ISO date/time upper bound'),
      success_only: z.boolean().optional().default(false).describe('Only show successful operations'),
      limit: z.number().optional().default(20).describe('Max entries to return (default 20, max 200)'),
    },
    async ({ customer_id, action, since, until, success_only, limit }) => {
      const entries = readHistory({
        customerId: customer_id,
        action,
        since,
        until,
        successOnly: success_only,
        limit: Math.min(limit ?? 20, 200),
      });
      if (!entries.length) {
        return { content: [{ type: 'text', text: 'No mutation history found matching the filters.' }] };
      }
      const formatted = entries.map((e) => ({
        timestamp: e.timestamp,
        action: e.action,
        customerId: e.customerId,
        success: e.success,
        preview: e.preview,
        params: e.params,
        ...(e.assetIds?.length ? { assetIds: e.assetIds } : {}),
        ...(e.error ? { error: e.error } : {}),
        ...(e.batchId ? { batchId: e.batchId } : {}),
      }));
      return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    },
  );

  server.tool(
    'get_mutation_stats',
    'Get summary statistics of past mutations: total count, success/fail rate, breakdown by action type, recently used asset IDs.',
    {
      customer_id: z.string().optional().describe('Filter stats by customer ID'),
    },
    async ({ customer_id }) => {
      const stats = getHistoryStats(customer_id);
      if (stats.total === 0) {
        return { content: [{ type: 'text', text: 'No mutation history yet.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    },
  );
}
