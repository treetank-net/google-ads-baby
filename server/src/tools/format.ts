import { enums } from 'google-ads-api';

type EnumTable = Record<string | number, string | number>;

const ENUM_COLUMNS: Record<string, EnumTable> = {
  'campaign.status': enums.CampaignStatus as EnumTable,
  'campaign.serving_status': enums.CampaignServingStatus as EnumTable,
  'campaign.advertising_channel_type': enums.AdvertisingChannelType as EnumTable,
  'campaign.advertising_channel_sub_type': enums.AdvertisingChannelSubType as EnumTable,
  'campaign.bidding_strategy_type': enums.BiddingStrategyType as EnumTable,
  'ad_group.status': enums.AdGroupStatus as EnumTable,
  'ad_group.type': enums.AdGroupType as EnumTable,
  'ad_group_ad.status': enums.AdGroupAdStatus as EnumTable,
  'ad_group_ad.ad.type': enums.AdType as EnumTable,
  'ad_group_criterion.status': enums.AdGroupCriterionStatus as EnumTable,
  'ad_group_criterion.type': enums.CriterionType as EnumTable,
  'ad_group_criterion.keyword.match_type': enums.KeywordMatchType as EnumTable,
  'campaign_criterion.type': enums.CriterionType as EnumTable,
  'asset.type': enums.AssetType as EnumTable,
  'conversion_action.status': enums.ConversionActionStatus as EnumTable,
  'conversion_action.category': enums.ConversionActionCategory as EnumTable,
  'user_list.type': enums.UserListType as EnumTable,
  'user_list.membership_status': enums.UserListMembershipStatus as EnumTable,
  status: enums.CampaignStatus as EnumTable,
  type: enums.AdvertisingChannelType as EnumTable,
  bidding_strategy_type: enums.BiddingStrategyType as EnumTable,
  category: enums.ConversionActionCategory as EnumTable,
};

export function decodeCell(column: string, value: unknown): unknown {
  const table = ENUM_COLUMNS[column];
  if (!table) return value;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return value;
  const name = table[value as keyof EnumTable];
  return typeof name === 'string' ? name : value;
}

export function shortenResourceName(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('customers/')) return value;
  const segments = value.split('/');
  return segments[segments.length - 1];
}

export function flattenRow(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    if (prefix) out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    const allScalar = value.every((item) => !item || typeof item !== 'object');
    const textObjects = value.length > 0 && value.every((item) => item && typeof item === 'object' && 'text' in (item as object));
    if (allScalar) out[prefix] = value.join(' ~ ');
    else if (textObjects) out[prefix] = value.map((item) => String((item as { text?: unknown }).text ?? '')).join(' ~ ');
    else out[prefix] = JSON.stringify(value);
    return out;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'resource_name') continue;
    flattenRow(item, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

export function trimPrecision(value: unknown): unknown {
  if (typeof value !== 'number' || Number.isInteger(value) || !Number.isFinite(value)) return value;
  return Number(value.toPrecision(6));
}

function escapeCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

export function toTsv(rows: unknown[]): string {
  const flat = rows.map((row) => flattenRow(row));
  const columns: string[] = [];
  for (const row of flat) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  if (!columns.length) return '';
  const lines = [columns.join('\t')];
  for (const row of flat) {
    lines.push(columns.map((column) => escapeCell(trimPrecision(decodeCell(column, shortenResourceName(row[column]))))).join('\t'));
  }
  return lines.join('\n');
}

export function tsvSection(label: string, rows: unknown[]): string {
  if (!rows.length) return `## ${label} (0)`;
  return `## ${label} (${rows.length})\n${toTsv(rows)}`;
}

export function tsvDocument(sections: Array<[string, unknown[]]>, header: string[] = []): string {
  const parts = header.length ? [header.join('\n')] : [];
  for (const [label, rows] of sections) parts.push(tsvSection(label, rows));
  parts.push('Values are tab-separated; ids are bare (resource names dropped); repeated fields are joined with " ~ ".');
  return parts.join('\n\n');
}
