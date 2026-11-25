import { enums } from 'google-ads-api';
import type { AdsConfig } from '../config.js';
import { executeGaql } from '../client.js';
import { normalizeResourceId } from '../validation.js';
import type { Row } from './table.js';
import { enumName } from './write-helpers.js';

export type AssetLinkLevel = 'CUSTOMER' | 'CAMPAIGN' | 'AD_GROUP';
export type AssetLinkStatus = 'ENABLED' | 'PAUSED' | 'REMOVED';

export const ASSET_LINK_LEVELS: AssetLinkLevel[] = ['CUSTOMER', 'CAMPAIGN', 'AD_GROUP'];

const LEVEL_RESOURCE: Record<AssetLinkLevel, string> = {
  CUSTOMER: 'customer_asset',
  CAMPAIGN: 'campaign_asset',
  AD_GROUP: 'ad_group_asset',
};

export const ASSET_LINK_METRICS_DAYS = 30;

export const MIN_LINKS_BY_FIELD_TYPE: Record<string, number> = {
  SITELINK: 2,
  CALLOUT: 2,
};

export interface AssetLinkFilter {
  assetIds?: string[];
  fieldTypes?: string[];
  campaignIds?: string[];
  adGroupIds?: string[];
  status?: string;
  includeRemoved?: boolean;
  levels?: AssetLinkLevel[];
}

export interface AssetLink {
  level: AssetLinkLevel;
  resourceName: string;
  status: string;
  fieldType: string;
  assetId: string;
  assetType: string;
  label: string;
  finalUrls: string[];
  campaignId?: string;
  campaignName?: string;
  campaignStatus?: string;
  channel?: string;
  adGroupId?: string;
  adGroupName?: string;
  adGroupStatus?: string;
  clicks?: number;
  costMicros?: number;
}

type EnumTable = Record<string | number, string | number>;

function idList(values: string[]): string {
  return [...new Set(values.map(normalizeResourceId))].join(',');
}

function quotedList(values: string[]): string {
  return [...new Set(values)].map((value) => `'${value}'`).join(',');
}

export function assetLinkLevels(filter: AssetLinkFilter): AssetLinkLevel[] {
  const requested = filter.levels?.length ? filter.levels : ASSET_LINK_LEVELS;
  if (filter.adGroupIds?.length) return requested.filter((level) => level === 'AD_GROUP');
  if (filter.campaignIds?.length) return requested.filter((level) => level !== 'CUSTOMER');
  return requested;
}

function linkFilters(level: AssetLinkLevel, filter: AssetLinkFilter): string[] {
  const key = LEVEL_RESOURCE[level];
  const filters: string[] = [];
  if (filter.assetIds?.length) filters.push(`asset.id IN (${idList(filter.assetIds)})`);
  if (filter.fieldTypes?.length) filters.push(`${key}.field_type IN (${quotedList(filter.fieldTypes)})`);
  if (filter.status) filters.push(`${key}.status = '${filter.status}'`);
  else if (!filter.includeRemoved) filters.push(`${key}.status != 'REMOVED'`);
  if (level !== 'CUSTOMER' && filter.campaignIds?.length) filters.push(`campaign.id IN (${idList(filter.campaignIds)})`);
  if (level === 'AD_GROUP' && filter.adGroupIds?.length) filters.push(`ad_group.id IN (${idList(filter.adGroupIds)})`);
  return filters;
}

const ASSET_FIELDS = [
  'asset.id',
  'asset.type',
  'asset.name',
  'asset.final_urls',
  'asset.sitelink_asset.link_text',
  'asset.sitelink_asset.description1',
  'asset.sitelink_asset.description2',
  'asset.callout_asset.callout_text',
  'asset.structured_snippet_asset.header',
  'asset.text_asset.text',
  'asset.call_asset.phone_number',
];

const CONTEXT_FIELDS: Record<AssetLinkLevel, string[]> = {
  CUSTOMER: [],
  CAMPAIGN: ['campaign.id', 'campaign.name', 'campaign.status', 'campaign.advertising_channel_type'],
  AD_GROUP: [
    'campaign.id', 'campaign.name', 'campaign.status', 'campaign.advertising_channel_type',
    'ad_group.id', 'ad_group.name', 'ad_group.status',
  ],
};

export function buildAssetLinkQuery(level: AssetLinkLevel, filter: AssetLinkFilter, limit?: number): string {
  const key = LEVEL_RESOURCE[level];
  const filters = linkFilters(level, filter);
  return `
    SELECT
      ${[`${key}.resource_name`, `${key}.status`, `${key}.field_type`, ...CONTEXT_FIELDS[level], ...ASSET_FIELDS].join(',\n      ')}
    FROM ${key}
    ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
    ${limit ? `LIMIT ${limit}` : ''}
  `;
}

export function buildAssetLinkMetricsQuery(level: AssetLinkLevel, filter: AssetLinkFilter, days = ASSET_LINK_METRICS_DAYS): string {
  const key = LEVEL_RESOURCE[level];
  const filters = [...linkFilters(level, filter), `segments.date DURING LAST_${days}_DAYS`];
  return `
    SELECT
      ${key}.resource_name,
      metrics.clicks,
      metrics.cost_micros
    FROM ${key}
    WHERE ${filters.join(' AND ')}
  `;
}

function assetLabel(asset: any): string {
  return String(
    asset?.sitelink_asset?.link_text
      ?? asset?.callout_asset?.callout_text
      ?? asset?.structured_snippet_asset?.header
      ?? asset?.text_asset?.text
      ?? asset?.call_asset?.phone_number
      ?? asset?.name
      ?? '',
  );
}

function optionalId(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

export function parseAssetLinkRows(level: AssetLinkLevel, rows: any[]): AssetLink[] {
  const key = LEVEL_RESOURCE[level];
  return rows.map((row) => {
    const link = row?.[key] ?? {};
    const asset = row?.asset ?? {};
    return {
      level,
      resourceName: String(link.resource_name ?? ''),
      status: enumName(enums.AssetLinkStatus as EnumTable, link.status),
      fieldType: enumName(enums.AssetFieldType as EnumTable, link.field_type),
      assetId: String(asset.id ?? ''),
      assetType: enumName(enums.AssetType as EnumTable, asset.type),
      label: assetLabel(asset),
      finalUrls: Array.isArray(asset.final_urls) ? asset.final_urls.map(String) : [],
      campaignId: level === 'CUSTOMER' ? undefined : optionalId(row?.campaign?.id),
      campaignName: level === 'CUSTOMER' ? undefined : optionalId(row?.campaign?.name),
      campaignStatus: level === 'CUSTOMER' ? undefined : enumName(enums.CampaignStatus as EnumTable, row?.campaign?.status) || undefined,
      channel: level === 'CUSTOMER' ? undefined : enumName(enums.AdvertisingChannelType as EnumTable, row?.campaign?.advertising_channel_type) || undefined,
      adGroupId: level === 'AD_GROUP' ? optionalId(row?.ad_group?.id) : undefined,
      adGroupName: level === 'AD_GROUP' ? optionalId(row?.ad_group?.name) : undefined,
      adGroupStatus: level === 'AD_GROUP' ? enumName(enums.AdGroupStatus as EnumTable, row?.ad_group?.status) || undefined : undefined,
    };
  });
}

export function mergeAssetLinkMetrics(links: AssetLink[], level: AssetLinkLevel, metricRows: any[]): AssetLink[] {
  const key = LEVEL_RESOURCE[level];
  const byName = new Map<string, { clicks: number; costMicros: number }>();
  for (const row of metricRows) {
    const name = String(row?.[key]?.resource_name ?? '');
    if (!name) continue;
    const current = byName.get(name) ?? { clicks: 0, costMicros: 0 };
    current.clicks += Number(row?.metrics?.clicks ?? 0);
    current.costMicros += Number(row?.metrics?.cost_micros ?? 0);
    byName.set(name, current);
  }
  return links.map((link) => {
    if (link.level !== level) return link;
    const metrics = byName.get(link.resourceName);
    return { ...link, clicks: metrics?.clicks ?? 0, costMicros: metrics?.costMicros ?? 0 };
  });
}

export function filterLinksByUrl(links: AssetLink[], needle: string | undefined): AssetLink[] {
  const wanted = needle?.trim().toLowerCase();
  if (!wanted) return links;
  return links.filter((link) => link.finalUrls.some((url) => url.toLowerCase().includes(wanted)));
}

const LEVEL_ORDER: Record<AssetLinkLevel, number> = { CUSTOMER: 0, CAMPAIGN: 1, AD_GROUP: 2 };

export function sortAssetLinks(links: AssetLink[]): AssetLink[] {
  return [...links].sort((a, b) =>
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
    || (a.campaignName ?? '').localeCompare(b.campaignName ?? '')
    || (a.adGroupName ?? '').localeCompare(b.adGroupName ?? '')
    || a.fieldType.localeCompare(b.fieldType)
    || a.assetId.localeCompare(b.assetId));
}

export function assetLinkTableRows(links: AssetLink[]): Row[] {
  return sortAssetLinks(links).map((link) => ({
    level: link.level,
    link_status: link.status,
    field_type: link.fieldType,
    asset_id: link.assetId,
    label: link.label,
    final_url: link.finalUrls.join(' '),
    campaign_id: link.campaignId,
    campaign: link.campaignName,
    campaign_status: link.campaignStatus,
    channel: link.channel,
    ad_group_id: link.adGroupId,
    ad_group: link.adGroupName,
    ad_group_status: link.adGroupStatus,
    clicks: link.clicks,
    cost: link.costMicros === undefined ? undefined : Math.round(link.costMicros / 10_000) / 100,
  }));
}

export async function loadAssetLinks(
  cfg: AdsConfig,
  customerId: string,
  filter: AssetLinkFilter,
  options: { metrics?: boolean; limit?: number } = {},
): Promise<AssetLink[]> {
  const levels = assetLinkLevels(filter);
  const perLevel = await Promise.all(levels.map(async (level) => {
    const [rows, metricRows] = await Promise.all([
      executeGaql(cfg, customerId, buildAssetLinkQuery(level, filter, options.limit)) as Promise<any[]>,
      options.metrics ? executeGaql(cfg, customerId, buildAssetLinkMetricsQuery(level, filter)) as Promise<any[]> : Promise.resolve([]),
    ]);
    const links = parseAssetLinkRows(level, rows);
    return options.metrics ? mergeAssetLinkMetrics(links, level, metricRows) : links;
  }));
  return perLevel.flat();
}

export interface LinkScope {
  customer?: boolean;
  campaignIds?: string[];
  adGroupIds?: string[];
}

export interface LinkStatusPlan {
  changes: AssetLink[];
  skipped: Array<{ link: AssetLink; reason: string }>;
  missing: string[];
  blocked: Array<{ link: AssetLink; reason: string }>;
}

export function linkEntityRef(link: AssetLink): string {
  if (link.level === 'CUSTOMER') return 'account';
  if (link.level === 'CAMPAIGN') return `campaign ${link.campaignId}`;
  return `ad group ${link.adGroupId}`;
}

function scopeIsEmpty(scope: LinkScope): boolean {
  return !scope.customer && !scope.campaignIds?.length && !scope.adGroupIds?.length;
}

function inScope(link: AssetLink, scope: LinkScope): boolean {
  if (scopeIsEmpty(scope)) return true;
  if (link.level === 'CUSTOMER') return Boolean(scope.customer);
  if (link.level === 'CAMPAIGN') return Boolean(link.campaignId && scope.campaignIds?.includes(link.campaignId));
  return Boolean(link.adGroupId && scope.adGroupIds?.includes(link.adGroupId));
}

export function planLinkStatusChange(links: AssetLink[], scope: LinkScope, newStatus: AssetLinkStatus): LinkStatusPlan {
  const selected = links.filter((link) => inScope(link, scope));
  const plan: LinkStatusPlan = { changes: [], skipped: [], missing: [], blocked: [] };
  for (const link of selected) {
    if (link.status === newStatus) plan.skipped.push({ link, reason: `already ${newStatus}` });
    else if (link.status === 'REMOVED') plan.blocked.push({ link, reason: 'link is REMOVED; Google Ads cannot re-enable a removed link, create a new one instead' });
    else plan.changes.push(link);
  }
  const found = (predicate: (link: AssetLink) => boolean) => selected.some(predicate);
  if (scope.customer && !found((link) => link.level === 'CUSTOMER')) plan.missing.push('account');
  for (const id of scope.campaignIds ?? []) {
    if (!found((link) => link.level === 'CAMPAIGN' && link.campaignId === id)) plan.missing.push(`campaign ${id}`);
  }
  for (const id of scope.adGroupIds ?? []) {
    if (!found((link) => link.level === 'AD_GROUP' && link.adGroupId === id)) plan.missing.push(`ad group ${id}`);
  }
  return plan;
}

function entityKey(link: AssetLink): string {
  return `${link.level}:${link.level === 'CAMPAIGN' ? link.campaignId : link.level === 'AD_GROUP' ? link.adGroupId : ''}:${link.fieldType}`;
}

function fieldLabel(fieldType: string): string {
  return `${fieldType.toLowerCase().replace(/_/g, ' ')}${fieldType.endsWith('S') ? '' : 's'}`;
}

export function linkCoverageLines(changes: AssetLink[], enabledSiblings: AssetLink[], newStatus: AssetLinkStatus): string[] {
  const lines: string[] = [];
  const touched = new Map<string, AssetLink>();
  for (const link of changes) touched.set(entityKey(link), link);
  const changedNames = new Set(changes.map((link) => link.resourceName));
  for (const [key, sample] of touched) {
    const enabledNow = enabledSiblings.filter((link) => entityKey(link) === key && link.status === 'ENABLED');
    const kept = enabledNow.filter((link) => !changedNames.has(link.resourceName)).length;
    const added = newStatus === 'ENABLED' ? changes.filter((link) => entityKey(link) === key).length : 0;
    const after = kept + added;
    const where = sample.level === 'CUSTOMER' ? 'account' : sample.level === 'CAMPAIGN' ? `campaign "${sample.campaignName}"` : `ad group "${sample.adGroupName}"`;
    const label = fieldLabel(sample.fieldType);
    const minimum = MIN_LINKS_BY_FIELD_TYPE[sample.fieldType] ?? 1;
    let line = `- ${where}: ${enabledNow.length} → ${after} enabled ${label}`;
    if (after < minimum) {
      if (after === 0 && sample.level !== 'CUSTOMER') {
        const fallbackLevel: AssetLinkLevel = sample.level === 'AD_GROUP' ? 'CAMPAIGN' : 'CUSTOMER';
        const fallback = enabledSiblings.filter((link) => link.level === fallbackLevel
          && link.fieldType === sample.fieldType
          && link.status === 'ENABLED'
          && (fallbackLevel === 'CUSTOMER' || link.campaignId === sample.campaignId)
          && !changedNames.has(link.resourceName)).length;
        line += fallback
          ? ` — ${fallbackLevel === 'CUSTOMER' ? 'account' : 'campaign'}-level ${label} (${fallback} enabled) will serve instead`
          : ` — WARNING: none at the ${fallbackLevel === 'CUSTOMER' ? 'account' : 'campaign'} level either, so no ${label} will serve here`;
      } else {
        line += ` — WARNING: below ${minimum}, Google may stop showing ${label}`;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function describeAsset(link: AssetLink): string {
  const url = link.finalUrls[0] ? ` → ${link.finalUrls[0]}` : '';
  return `${link.fieldType.toLowerCase()} "${link.label}"${url} (asset ${link.assetId})`;
}

export function describeLinkTarget(link: AssetLink): string {
  if (link.level === 'CUSTOMER') return 'account level';
  const campaign = `campaign "${link.campaignName}" (${link.campaignId}${link.channel ? `, ${link.channel}` : ''}${link.campaignStatus ? `, ${link.campaignStatus}` : ''})`;
  if (link.level === 'CAMPAIGN') return campaign;
  return `ad group "${link.adGroupName}" (${link.adGroupId}${link.adGroupStatus ? `, ${link.adGroupStatus}` : ''}) in ${campaign}`;
}
