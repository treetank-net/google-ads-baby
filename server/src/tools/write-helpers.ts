import { enums } from 'google-ads-api';
import type { AdsConfig } from '../config.js';
import { executeGaql } from '../client.js';
import { BATCH_ACTION, createToken, getTokenTtlSeconds, listPending } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId, requireCustomerId } from '../validation.js';
import {
  MAX_IMAGE_BYTES,
  CODEX_HOOK_INSTALL_COMMAND,
} from './write-schemas.js';
import {
  type AmountLimits,
  amountToMicros,
  formatAmount,
  formatAmountExact,
  formatUnits,
} from './amounts.js';

export {
  type AmountLimits,
  amountToMicros,
  formatAmount,
  formatAmountExact,
  formatUnits,
  loadAmountLimits,
  resolveAmountLimits,
  amountFieldDescription,
} from './amounts.js';

export function validationResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

function limitError(label: string, units: number, maxMicros: number, currency: string, per = ''): string | null {
  return amountToMicros(units) > maxMicros
    ? `${label} ${formatUnits(units, currency)} exceeds the safety limit (${formatAmount(maxMicros, currency)}${per}).`
    : null;
}

export function budgetLimitError(units: number, limits: AmountLimits): string | null {
  return limitError('Budget', units, limits.budgetMicros, limits.currency, '/day');
}

export function cpcLimitError(units: number, limits: AmountLimits): string | null {
  return limitError('CPC bid', units, limits.cpcMicros, limits.currency);
}

export function targetCpaLimitError(units: number, limits: AmountLimits): string | null {
  return limitError('Target CPA', units, limits.targetCpaMicros, limits.currency);
}

export const AMOUNT_FIELD_LIMITS: Array<{ match: RegExp; label: string; maxMicros: (limits: AmountLimits) => number }> = [
  { match: /cpc/, label: 'CPC bid', maxMicros: (limits) => limits.cpcMicros },
  { match: /cpa/, label: 'Target CPA', maxMicros: (limits) => limits.targetCpaMicros },
  { match: /budget/, label: 'Budget', maxMicros: (limits) => limits.budgetMicros },
];

export function amountFieldLimitError(value: unknown, limits: AmountLimits, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = amountFieldLimitError(value[index], limits, `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const fieldPath = path ? `${path}.${key}` : key;
    if (key.endsWith('_amount') && typeof item === 'number') {
      const rule = AMOUNT_FIELD_LIMITS.find((candidate) => candidate.match.test(key))
        ?? { label: 'Amount', maxMicros: (l: AmountLimits) => l.budgetMicros };
      const maxMicros = rule.maxMicros(limits);
      if (amountToMicros(item) > maxMicros) {
        return `${rule.label} ${formatUnits(item, limits.currency)} in ${fieldPath} exceeds the safety limit (${formatAmount(maxMicros, limits.currency)}).`;
      }
      continue;
    }
    const error = amountFieldLimitError(item, limits, fieldPath);
    if (error) return error;
  }
  return null;
}

export function changeLine(label: string, before: unknown, after: unknown): string {
  const from = before === undefined || before === null || before === '' ? '(not set)' : String(before);
  return `${label}: ${from} → ${String(after)}`;
}

export function textChangeLines(label: string, before: string[], after: string[]): string[] {
  const kept = new Set(after.filter((value) => before.includes(value)));
  const mark = (value: string, marker: string) => `    ${kept.has(value) ? '=' : marker} ${value}`;
  return [
    `${label}: ${before.length} item(s) → ${after.length} item(s)`,
    `  before:`,
    ...(before.length ? before.map((value) => mark(value, '-')) : ['    (none)']),
    `  after:`,
    ...(after.length ? after.map((value) => mark(value, '+')) : ['    (none)']),
  ];
}

export function microsChangeLine(label: string, beforeMicros: number | undefined, afterMicros: number, currency: string): string {
  const base = `${label}: ${formatAmountExact(beforeMicros, currency)} → ${formatAmountExact(afterMicros, currency)}`;
  if (!beforeMicros || beforeMicros <= 0) return base;
  const factor = afterMicros / beforeMicros;
  if (factor >= 1.5) return `${base} (${factor.toFixed(1)}x more)`;
  if (factor > 0 && factor <= 0.67) return `${base} (${(1 / factor).toFixed(1)}x less)`;
  const percent = (factor - 1) * 100;
  return `${base} (${percent >= 0 ? '+' : ''}${percent.toFixed(0)}%)`;
}

type EnumTable = Record<string | number, string | number>;

export function enumName(table: EnumTable, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const name = table[value as keyof EnumTable];
  return typeof name === 'string' ? name : String(value);
}

export const CPC_BID_HONORING_STRATEGIES = new Set(['MANUAL_CPC', 'ENHANCED_CPC', 'PERCENT_CPC']);

export function manualBiddingRequiredWarning(biddingStrategyType: string | undefined): string | null {
  if (!biddingStrategyType || CPC_BID_HONORING_STRATEGIES.has(biddingStrategyType)) return null;
  return `Warning: campaign bidding strategy is ${biddingStrategyType}. Google ignores ad group CPC bids unless the campaign bids on clicks (${[...CPC_BID_HONORING_STRATEGIES].join(', ')}), so this bid change will not affect delivery.`;
}

export function removedResourceError(label: string, name: string, status: string | undefined): string | null {
  if (status !== 'REMOVED') return null;
  const described = name ? `${label} "${name}"` : label;
  return `${described} is REMOVED. Google Ads rejects every edit to a removed resource (OPERATION_NOT_PERMITTED_FOR_REMOVED_RESOURCE) and removal is permanent, so this change cannot succeed. Recreate the entity instead, or pick a different one.`;
}

export function sharedBudgetWarning(referenceCount: number | undefined, explicitlyShared: boolean | undefined): string | null {
  const count = referenceCount ?? 0;
  if (count > 1) {
    return `Warning: this budget is shared by ${count} campaigns. Changing it affects every one of them, not only this campaign.`;
  }
  if (!explicitlyShared) return null;
  return 'Note: this is a shared budget resource, currently used by this campaign only. Changing it is safe today, but any campaign later attached to it inherits the new amount.';
}

export function validateCustomer(customerId: string) {
  const error = requireCustomerId(customerId);
  return error ? validationResult(error) : null;
}

export function normalizeSafeWord(safeWord: string): string {
  return safeWord.trim();
}

export function gaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function resourceNameLiteral(value: string): string {
  return `'${gaqlString(value.trim())}'`;
}

export function adFilter(sourceAdId?: string, sourceAdGroupAdResourceName?: string): string | null {
  if (sourceAdGroupAdResourceName?.trim()) {
    return `ad_group_ad.resource_name = ${resourceNameLiteral(sourceAdGroupAdResourceName)}`;
  }
  if (sourceAdId?.trim()) {
    return `ad_group_ad.ad.id = ${normalizeResourceId(sourceAdId)}`;
  }
  return null;
}

export function assetIdFromResourceName(resourceName: string | undefined): string | null {
  const match = resourceName?.match(/\/assets\/(\d+)$/);
  return match ? match[1] : null;
}

export function textValues(items: Array<{ text?: string }> | undefined): string[] {
  return (items ?? []).map((item) => item.text).filter((value): value is string => Boolean(value));
}

export function assetIds(items: Array<{ asset?: string }> | undefined): string[] {
  return (items ?? [])
    .map((item) => assetIdFromResourceName(item.asset))
    .filter((value): value is string => Boolean(value));
}

export function buildCloneAdQuery(filter: string) {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group_ad.resource_name,
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
    WHERE ${filter}
    LIMIT 2
  `;
}

export function validateResponsiveSearchInput(headlines: string[], descriptions: string[]): string | null {
  if (headlines.length < 3 || headlines.length > 15) return 'Responsive search ad clone needs 3-15 headlines.';
  if (headlines.some((headline) => headline.length > 30)) return 'Responsive search ad headlines must be max 30 chars each.';
  if (descriptions.length < 2 || descriptions.length > 4) return 'Responsive search ad clone needs 2-4 descriptions.';
  if (descriptions.some((description) => description.length > 90)) return 'Responsive search ad descriptions must be max 90 chars each.';
  return null;
}

export function validateResponsiveDisplayInput(input: {
  businessName: string;
  headlines: string[];
  longHeadline: string;
  descriptions: string[];
  marketingImageAssetIds: string[];
  squareMarketingImageAssetIds: string[];
  logoImageAssetIds: string[];
}): string | null {
  if (!input.businessName || input.businessName.length > 25) return 'Responsive display ad clone needs a business name up to 25 chars.';
  if (input.headlines.length < 1 || input.headlines.length > 5 || input.headlines.some((headline) => headline.length > 30)) return 'Responsive display ad clone needs 1-5 headlines, max 30 chars each.';
  if (!input.longHeadline || input.longHeadline.length > 90) return 'Responsive display ad clone needs a long headline up to 90 chars.';
  if (input.descriptions.length < 1 || input.descriptions.length > 5 || input.descriptions.some((description) => description.length > 90)) return 'Responsive display ad clone needs 1-5 descriptions, max 90 chars each.';
  if (input.marketingImageAssetIds.length < 1 || input.marketingImageAssetIds.length > 15) return 'Responsive display ad clone needs 1-15 marketing image asset IDs.';
  if (input.squareMarketingImageAssetIds.length < 1 || input.squareMarketingImageAssetIds.length > 15) return 'Responsive display ad clone needs 1-15 square marketing image asset IDs.';
  if (input.logoImageAssetIds.length > 5) return 'Responsive display ad clone can use at most 5 logo image asset IDs.';
  return null;
}

export function validateResponsiveDisplayText(headlines: string[], descriptions: string[]): string | null {
  if (headlines.length < 1 || headlines.length > 5 || headlines.some((headline) => headline.length > 30)) return 'Responsive display ad needs 1-5 headlines, max 30 chars each.';
  if (descriptions.length < 1 || descriptions.length > 5 || descriptions.some((description) => description.length > 90)) return 'Responsive display ad needs 1-5 descriptions, max 90 chars each.';
  return null;
}

export type ImageInfo = {
  format: 'jpeg' | 'png' | 'gif' | 'webp';
  width: number;
  height: number;
  bytes: number;
  aspectRatio: number;
  warnings: string[];
};

function parseImageDimensions(data: Buffer): Omit<ImageInfo, 'bytes' | 'aspectRatio' | 'warnings'> | null {
  if (data.length >= 24 && data.toString('ascii', 1, 4) === 'PNG') {
    return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }

  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }

  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && data.length >= 30) {
      return {
        format: 'webp',
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8 ' && data.length >= 30) {
      return { format: 'webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && data.length >= 25) {
      const bits = data.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (length < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { format: 'jpeg', width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }

  return null;
}

function imageWarnings(width: number, height: number, bytes: number): string[] {
  const warnings: string[] = [];
  const ratio = width / height;
  if (width < 128 || height < 128) warnings.push('Image is very small; many Google Ads placements require at least 128px on the shorter side.');
  if (bytes > 5_000_000) warnings.push('Image is over 5 MB; it is below the server cap but may be inconvenient to reuse.');
  if (Math.abs(ratio - 1) < 0.03) warnings.push('Likely suitable for square marketing image or square logo usage.');
  if (Math.abs(ratio - 1.91) < 0.08) warnings.push('Likely suitable for landscape marketing image usage.');
  if (ratio >= 3 && ratio <= 5) warnings.push('Likely suitable for landscape logo usage.');
  if (warnings.length === 0) warnings.push('Aspect ratio does not match common responsive display slots exactly; verify intended usage before linking this asset.');
  return warnings;
}

export function inspectImageBuffer(data: Buffer): ImageInfo | null {
  const dimensions = parseImageDimensions(data);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
  return {
    ...dimensions,
    bytes: data.length,
    aspectRatio: Number((dimensions.width / dimensions.height).toFixed(4)),
    warnings: imageWarnings(dimensions.width, dimensions.height, data.length),
  };
}

export function formatImageInfo(info: ImageInfo): string[] {
  return [
    `Detected image: ${info.format.toUpperCase()}, ${info.width}x${info.height}, aspect ${info.aspectRatio}, ${info.bytes} bytes`,
    ...info.warnings.map((warning) => `Image note: ${warning}`),
  ];
}

export async function fetchImageForPreview(url: string): Promise<{ data: Buffer; contentType: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image preview download failed: HTTP ${response.status} from ${url}`);
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (${contentLength} bytes). Max allowed: ${MAX_IMAGE_BYTES} bytes.`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${data.length} bytes). Max allowed: ${MAX_IMAGE_BYTES} bytes.`);
  return { data, contentType: response.headers.get('content-type') || 'unknown' };
}

export async function loadImageAssetInfo(cfg: AdsConfig, customerId: string, assetIds: string[]): Promise<Record<string, { width?: number; height?: number; url?: string }>> {
  const uniqueIds = [...new Set(assetIds.map(normalizeResourceId))];
  if (!uniqueIds.length) return {};
  const rows = await executeGaql(cfg, customerId, `
    SELECT
      asset.id,
      asset.image_asset.full_size.url,
      asset.image_asset.full_size.width_pixels,
      asset.image_asset.full_size.height_pixels
    FROM asset
    WHERE asset.id IN (${uniqueIds.join(',')})
  `) as any[];
  const out: Record<string, { width?: number; height?: number; url?: string }> = {};
  for (const row of rows) {
    const asset = row.asset ?? {};
    out[String(asset.id)] = {
      width: asset.image_asset?.full_size?.width_pixels,
      height: asset.image_asset?.full_size?.height_pixels,
      url: asset.image_asset?.full_size?.url,
    };
  }
  return out;
}

export interface AdGroupState {
  adGroupId: string;
  name: string;
  status: string;
  cpcBidMicros?: number;
  type: string;
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  biddingStrategyType?: string;
}

export async function loadAdGroupState(cfg: AdsConfig, customerId: string, adGroupId: string): Promise<AdGroupState | null> {
  const rows = await executeGaql(cfg, customerId, `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.cpc_bid_micros,
      ad_group.type,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.bidding_strategy_type
    FROM ad_group
    WHERE ad_group.id = ${normalizeResourceId(adGroupId)}
    LIMIT 1
  `) as any[];
  const row = rows[0];
  if (!row) return null;
  return {
    adGroupId: String(row.ad_group?.id ?? adGroupId),
    name: String(row.ad_group?.name ?? ''),
    status: enumName(enums.AdGroupStatus as EnumTable, row.ad_group?.status),
    cpcBidMicros: row.ad_group?.cpc_bid_micros === undefined ? undefined : Number(row.ad_group.cpc_bid_micros),
    type: enumName(enums.AdGroupType as EnumTable, row.ad_group?.type),
    campaignId: String(row.campaign?.id ?? ''),
    campaignName: String(row.campaign?.name ?? ''),
    campaignStatus: enumName(enums.CampaignStatus as EnumTable, row.campaign?.status),
    biddingStrategyType: row.campaign?.bidding_strategy_type === undefined
      ? undefined
      : enumName(enums.BiddingStrategyType as EnumTable, row.campaign.bidding_strategy_type),
  };
}

export interface CampaignState {
  campaignId: string;
  name: string;
  status: string;
  biddingStrategyType?: string;
  budgetId?: string;
  budgetAmountMicros?: number;
  budgetExplicitlyShared?: boolean;
  budgetReferenceCount?: number;
}

export async function loadCampaignState(cfg: AdsConfig, customerId: string, campaignId: string): Promise<CampaignState | null> {
  const rows = await executeGaql(cfg, customerId, `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.bidding_strategy_type,
      campaign_budget.id,
      campaign_budget.amount_micros,
      campaign_budget.explicitly_shared,
      campaign_budget.reference_count
    FROM campaign
    WHERE campaign.id = ${normalizeResourceId(campaignId)}
    LIMIT 1
  `) as any[];
  const row = rows[0];
  if (!row) return null;
  return {
    campaignId: String(row.campaign?.id ?? campaignId),
    name: String(row.campaign?.name ?? ''),
    status: enumName(enums.CampaignStatus as EnumTable, row.campaign?.status),
    biddingStrategyType: row.campaign?.bidding_strategy_type === undefined
      ? undefined
      : enumName(enums.BiddingStrategyType as EnumTable, row.campaign.bidding_strategy_type),
    budgetId: row.campaign_budget?.id === undefined ? undefined : String(row.campaign_budget.id),
    budgetAmountMicros: row.campaign_budget?.amount_micros === undefined ? undefined : Number(row.campaign_budget.amount_micros),
    budgetExplicitlyShared: row.campaign_budget?.explicitly_shared,
    budgetReferenceCount: row.campaign_budget?.reference_count === undefined ? undefined : Number(row.campaign_budget.reference_count),
  };
}

export interface BudgetState {
  budgetId: string;
  name: string;
  amountMicros?: number;
  explicitlyShared?: boolean;
  referenceCount?: number;
  campaignNames: string[];
}

export async function loadBudgetState(cfg: AdsConfig, customerId: string, budgetId: string): Promise<BudgetState | null> {
  const normalizedBudgetId = normalizeResourceId(budgetId);
  const rows = await executeGaql(cfg, customerId, `
    SELECT
      campaign_budget.id,
      campaign_budget.name,
      campaign_budget.amount_micros,
      campaign_budget.explicitly_shared,
      campaign_budget.reference_count,
      campaign.name,
      campaign.status
    FROM campaign
    WHERE campaign_budget.id = ${normalizedBudgetId}
      AND campaign.status != 'REMOVED'
  `) as any[];
  const budgetRows = await executeGaql(cfg, customerId, `
    SELECT
      campaign_budget.id,
      campaign_budget.name,
      campaign_budget.amount_micros,
      campaign_budget.explicitly_shared,
      campaign_budget.reference_count
    FROM campaign_budget
    WHERE campaign_budget.id = ${normalizedBudgetId}
    LIMIT 1
  `) as any[];
  const budget = budgetRows[0]?.campaign_budget ?? rows[0]?.campaign_budget;
  if (!budget) return null;
  return {
    budgetId: String(budget.id ?? normalizedBudgetId),
    name: String(budget.name ?? ''),
    amountMicros: budget.amount_micros === undefined ? undefined : Number(budget.amount_micros),
    explicitlyShared: budget.explicitly_shared,
    referenceCount: budget.reference_count === undefined ? undefined : Number(budget.reference_count),
    campaignNames: rows.map((row) => String(row.campaign?.name ?? '')).filter(Boolean),
  };
}

export function statedAmountMismatchWarning(statedMicros: number | undefined, actualMicros: number | undefined, currency: string): string | null {
  if (statedMicros === undefined || actualMicros === undefined) return null;
  if (statedMicros === actualMicros) return null;
  return `Warning: the current amount was given as ${formatAmountExact(statedMicros, currency)}, but the account reports ${formatAmountExact(actualMicros, currency)}. The preview above uses the value read from the account.`;
}

export interface AdState {
  adId: string;
  adGroupId: string;
  adGroupName: string;
  adGroupStatus: string;
  campaignName: string;
  campaignStatus: string;
  status: string;
  type: string;
  finalUrls: string[];
  headlines: string[];
  descriptions: string[];
}

export async function loadAdState(cfg: AdsConfig, customerId: string, adId: string): Promise<AdState | null> {
  const rows = await executeGaql(cfg, customerId, buildCloneAdQuery(`ad_group_ad.ad.id = ${normalizeResourceId(adId)}`)) as any[];
  const row = rows[0];
  if (!row) return null;
  const ad = row.ad_group_ad?.ad ?? {};
  const isDisplay = Boolean(ad.responsive_display_ad);
  const creative = isDisplay ? ad.responsive_display_ad : ad.responsive_search_ad;
  return {
    adId: String(ad.id ?? adId),
    adGroupId: String(row.ad_group?.id ?? ''),
    adGroupName: String(row.ad_group?.name ?? ''),
    adGroupStatus: enumName(enums.AdGroupStatus as EnumTable, row.ad_group?.status),
    campaignName: String(row.campaign?.name ?? ''),
    campaignStatus: enumName(enums.CampaignStatus as EnumTable, row.campaign?.status),
    status: enumName(enums.AdGroupAdStatus as EnumTable, row.ad_group_ad?.status),
    type: enumName(enums.AdType as EnumTable, ad.type),
    finalUrls: (ad.final_urls ?? []) as string[],
    headlines: textValues(creative?.headlines),
    descriptions: textValues(creative?.descriptions),
  };
}

export function ratioOk(width: number | undefined, height: number | undefined, min: number, max: number): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= min && ratio <= max;
}

export function validateAssetPlacement(label: string, assetIds: string[], info: Record<string, { width?: number; height?: number }>, minRatio: number, maxRatio: number): string | null {
  for (const assetId of assetIds) {
    const dimensions = info[assetId];
    if (!dimensions?.width || !dimensions.height) return `${label} asset ${assetId} has no readable image dimensions.`;
    if (!ratioOk(dimensions.width, dimensions.height, minRatio, maxRatio)) {
      const ratio = Number((dimensions.width / dimensions.height).toFixed(4));
      return `${label} asset ${assetId} has ratio ${ratio} (${dimensions.width}x${dimensions.height}); expected ${minRatio}-${maxRatio}.`;
    }
  }
  return null;
}

export function safetyHookNotice(cfg: AdsConfig, safeWord?: string) {
  if (cfg.safetyLevel === 'off') {
    return {
      clientHookGate: 'disabled',
      note: 'Safety level is off. Server-side one-shot mutation tokens are still required, but the client hook gate is disabled.',
    };
  }

  return {
    clientHookGate: 'required',
    codexStatus: 'Codex currently does not reliably activate plugin-local hooks. If Codex UI says "No plugin hooks", treat hooks as not installed.',
    codexHookInstall: CODEX_HOOK_INSTALL_COMMAND,
    llmInstruction: [
      'Before calling confirm_mutation, ensure the user has installed/enabled the Google Ads Baby safety hooks.',
      'In Codex, plugin installation alone may only enable MCP. Ask the user to install the hook package if hooks are missing.',
      safeWord ? `Then show the preview and ask the user to reply with the safe word "${safeWord}".` : 'Then show the preview and ask the user to reply with the safe word.',
      'Do not call confirm_mutation in the same assistant turn as prepare_*.',
    ].join(' '),
  };
}

/**
 * Operations still waiting for confirmation, other than the one just prepared.
 *
 * Batching used to be a decision that had to be made before the first
 * `prepare_*`, and nothing told the caller that the queue already held something
 * confirmable together with this — so separately prepared changes ended up
 * costing the user one safe word each. Batching stays an explicit call
 * (`prepare_batch`), because the queue is shared by every session on this server
 * process and folding automatically would drag in operations nobody in this
 * conversation asked for.
 */
export function batchableOperations(currentToken: string) {
  return listPending()
    .filter((item) => item.token !== currentToken && item.action !== BATCH_ACTION)
    .map((item) => ({
      token: item.token,
      action: item.action,
      preview: truncateLine(item.preview),
      ageSeconds: Math.max(0, Math.round((Date.now() - item.createdAt) / 1000)),
    }));
}

function truncateLine(preview: string): string {
  const line = preview.split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export function prepareResponse(cfg: AdsConfig, mutation: { token: string; safeWord: string }, preview: string) {
  const alsoPending = batchableOperations(mutation.token);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        preview,
        token: mutation.token,
        safeWord: mutation.safeWord,
        expiresInSeconds: getTokenTtlSeconds(),
        instruction: `Show the user the preview and ask them to reply with the word "${mutation.safeWord}". Only after such a reply, call confirm_mutation with the token.`,
        ...(alsoPending.length ? {
          alsoPending,
          batchHint: [
            `${alsoPending.length} other operation(s) are already prepared and awaiting confirmation.`,
            'If more changes are coming, keep calling prepare_* first — do not ask the user to confirm yet.',
            `When the set is complete, call prepare_batch with all ${alsoPending.length + 1} tokens: it returns one combined preview and ONE new safe word, so the user confirms once instead of ${alsoPending.length + 1} times.`,
            'To drop an operation you no longer want, call discard_pending_mutations with its token — nothing reaches Google Ads.',
            'Only fold operations this conversation prepared; the queue is shared by every session on this server process.',
          ].join(' '),
        } : {}),
        safety: safetyHookNotice(cfg, mutation.safeWord),
      }, null, 2),
    }],
  };
}
