import { z } from 'zod';
import { normalizeResourceId } from '../validation.js';
import { decodeCell, decodeEnumsDeep } from './format.js';

export const entitySchema = z.enum(['campaigns', 'ad_groups', 'ads', 'keywords', 'negative_keywords', 'assets', 'ad_asset_links']);
export const upperTokenSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Use a Google Ads enum value, e.g. ENABLED, PAUSED, SEARCH, RESPONSIVE_DISPLAY_AD');

export type AdBlueprintInput = {
  customer_id: string;
  ad_id?: string;
  ad_group_ad_resource_name?: string;
};

export function gaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export const DEFAULT_FETCH_LIMIT = 2000;
export const MAX_FETCH_LIMIT = 5000;

export function normalizeLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_FETCH_LIMIT), MAX_FETCH_LIMIT));
}

export const pageSchema = z.number().int().positive().optional()
  .describe('Page number (default 1). Results are split into pages by response size; the response says how many pages there are.');

export const pageCharsSchema = z.number().int().min(4_000).max(200_000).optional()
  .describe('Max characters per page (default 40000). Raise it only when you deliberately want a bigger single response.');

export function resourceNameLiteral(value: string): string {
  return `'${gaqlString(value.trim())}'`;
}

export function buildCampaignStructureQuery(): string {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status != 'REMOVED'
    ORDER BY campaign.name
  `;
}

export function buildCampaignMetricsQuery(days: 7 | 30): string {
  return `
    SELECT
      campaign.id,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING LAST_${days}_DAYS
  `;
}

const ZERO_METRICS = {
  impressions: 0,
  clicks: 0,
  ctr: 0,
  cost_micros: 0,
  conversions: 0,
  conversions_value: 0,
};

/**
 * A campaign that served nothing still exists, and that is exactly the case a
 * user asks about. So the structure query drives the list and metrics are joined
 * onto it — a single query with `segments.date` drops every campaign without a
 * statistics row for the window, which used to make paused and non-serving
 * campaigns invisible.
 */
export function mergeCampaignMetrics(structureRows: any[], metricRows: any[]): unknown[] {
  const metricsById = new Map<string, any>();
  for (const row of metricRows) {
    const id = String(row?.campaign?.id ?? '');
    if (id) metricsById.set(id, row?.metrics ?? {});
  }
  return structureRows
    .map((row) => ({
      ...row,
      metrics: { ...ZERO_METRICS, ...(metricsById.get(String(row?.campaign?.id ?? '')) ?? {}) },
    }))
    .sort(
      (a, b) =>
        Number(b.metrics.cost_micros ?? 0) - Number(a.metrics.cost_micros ?? 0) ||
        String(a.campaign?.name ?? '').localeCompare(String(b.campaign?.name ?? '')),
    );
}

export function adFilter(input: AdBlueprintInput): string | null {
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

function textValues(items: Array<{ text?: string }> | undefined): string[] {
  return (items ?? []).map((item) => item.text).filter((value): value is string => Boolean(value));
}

function assetRefs(items: Array<{ asset?: string }> | undefined): string[] {
  return (items ?? []).map((item) => item.asset).filter((value): value is string => Boolean(value));
}

export function buildAdBlueprint(adRow: any, assetRows: any[]) {
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
    const field = String(decodeCell('ad_group_ad_asset_view.field_type', view.field_type) ?? 'UNKNOWN');
    grouped[field] = grouped[field] ?? [];
    grouped[field].push({
      id: asset.id,
      name: asset.name,
      type: decodeCell('asset.type', asset.type),
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

  return decodeEnumsDeep({
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
  });
}

export function buildAdQuery(filter: string) {
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

export function buildAdAssetQuery(filter: string) {
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

export function addCommonFilters(filters: string[], input: {
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

export function buildListQuery(input: {
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

    case 'keywords':
      addCommonFilters(filters, input, {
        status: 'ad_group_criterion.status',
        type: 'ad_group_criterion.keyword.match_type',
      });
      if (input.name_contains) filters.push(`ad_group_criterion.keyword.text LIKE '%${gaqlString(input.name_contains)}%'`);
      filters.push('ad_group_criterion.type = \'KEYWORD\'');
      filters.push('ad_group_criterion.negative = false');
      return `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          ad_group.id,
          ad_group.name,
          ad_group.status,
          ad_group_criterion.criterion_id,
          ad_group_criterion.status,
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.cpc_bid_micros,
          ad_group_criterion.effective_cpc_bid_micros
        FROM ad_group_criterion
        WHERE ${filters.join(' AND ')}
        ORDER BY campaign.name, ad_group.name, ad_group_criterion.keyword.text
        LIMIT ${limit}
      `;

    case 'negative_keywords':
      if (input.ad_group_id) {
        filters.push(`ad_group.id = ${normalizeResourceId(input.ad_group_id)}`);
        if (input.campaign_id) filters.push(`campaign.id = ${normalizeResourceId(input.campaign_id)}`);
        if (input.type) filters.push(`ad_group_criterion.keyword.match_type = '${input.type}'`);
        if (input.name_contains) filters.push(`ad_group_criterion.keyword.text LIKE '%${gaqlString(input.name_contains)}%'`);
        filters.push('ad_group_criterion.type = \'KEYWORD\'');
        filters.push('ad_group_criterion.negative = true');
        return `
          SELECT
            campaign.id,
            campaign.name,
            ad_group.id,
            ad_group.name,
            ad_group_criterion.criterion_id,
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type
          FROM ad_group_criterion
          WHERE ${filters.join(' AND ')}
          ORDER BY campaign.name, ad_group.name, ad_group_criterion.keyword.text
          LIMIT ${limit}
        `;
      }
      if (input.campaign_id) filters.push(`campaign.id = ${normalizeResourceId(input.campaign_id)}`);
      if (input.type) filters.push(`campaign_criterion.keyword.match_type = '${input.type}'`);
      if (input.name_contains) filters.push(`campaign_criterion.keyword.text LIKE '%${gaqlString(input.name_contains)}%'`);
      filters.push('campaign_criterion.type = \'KEYWORD\'');
      filters.push('campaign_criterion.negative = true');
      return `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign_criterion.criterion_id,
          campaign_criterion.status,
          campaign_criterion.keyword.text,
          campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE ${filters.join(' AND ')}
        ORDER BY campaign.name, campaign_criterion.keyword.text
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
