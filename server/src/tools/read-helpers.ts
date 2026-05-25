import { z } from 'zod';
import { normalizeResourceId } from '../validation.js';

export const entitySchema = z.enum(['campaigns', 'ad_groups', 'ads', 'assets', 'ad_asset_links']);
export const upperTokenSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Use a Google Ads enum value, e.g. ENABLED, PAUSED, SEARCH, RESPONSIVE_DISPLAY_AD');

export type AdBlueprintInput = {
  customer_id: string;
  ad_id?: string;
  ad_group_ad_resource_name?: string;
};

export function gaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function normalizeLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(limit ?? 50), 200));
}

export function resourceNameLiteral(value: string): string {
  return `'${gaqlString(value.trim())}'`;
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
