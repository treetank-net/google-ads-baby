import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, statSync } from 'fs';
import type { AdsConfig } from '../config.js';
import {
  createAdGroup,
  createAssetGroup,
  createAssetGroupAssets,
  createAssetGroupListingGroupFilters,
  createAssetGroupSignals,
  createCampaignTargeting,
  createDisplayAdGroup,
  createDisplayCampaign,
  createKeywords,
  createNegativeKeywords,
  createPerformanceMaxCampaign,
  createResponsiveDisplayAd,
  createResponsiveSearchAd,
  createSearchCampaign,
  executeGaql,
  mutateCampaignBudget,
  mutateCampaignStatus,
  removeCampaigns,
  uploadImageAssetFromFile,
  uploadImageAssetFromUrl,
} from '../client.js';
import { confirmPendingSafeWord, createToken, consumeConfirmState, consumeToken, getPendingToken, getTokenTtlSeconds, listPending } from '../confirm.js';
import { formatError } from '../errors.js';
import { normalizeCustomerId, normalizeResourceId, requireCustomerId } from '../validation.js';

const MAX_BUDGET_MICROS = 500_000_000; // 500 PLN safety cap
const MAX_CPC_MICROS = 50_000_000; // 50 PLN safety cap
const MAX_IMAGE_BYTES = 10_000_000; // 10 MB safety cap
const MAX_KEYWORDS_PER_MUTATION = 100;
const MAX_TARGETING_CRITERIA_PER_MUTATION = 100;
const MAX_ASSET_GROUP_ASSETS_PER_MUTATION = 100;
const MAX_ASSET_GROUP_SIGNALS_PER_MUTATION = 20;
const MAX_ASSET_GROUP_LISTING_GROUP_NODES_PER_MUTATION = 20;
const CODEX_HOOK_INSTALL_COMMAND = 'npx codex-marketplace add treetank-net/google-ads-baby/hooks/google-ads-baby-safety --hook --global';
const safeWordSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{2,39}$/, 'safe_word must be one short ASCII word, 3-40 chars, no spaces');
const campaignRefSchema = z.object({
  campaign_id: z.string().describe('Campaign ID'),
  campaign_name: z.string().describe('Campaign name for preview'),
});
const displayAssetIdListSchema = z.array(z.string()).min(1).max(15);
const displayLogoAssetIdListSchema = z.array(z.string()).max(5);
const cloneEntitySchema = z.enum(['ad', 'ad_group', 'campaign']);
const keywordMatchTypeSchema = z.enum(['BROAD', 'PHRASE', 'EXACT']);
const keywordSchema = z.object({
  text: z.string().min(1).max(80).describe('Keyword text, max 80 chars'),
  match_type: keywordMatchTypeSchema.describe('Keyword match type'),
});
const negativeKeywordLevelSchema = z.enum(['campaign', 'ad_group']);
const criterionIdListSchema = z.array(z.string().regex(/^\d+$/, 'Criterion IDs must be numeric')).max(MAX_TARGETING_CRITERIA_PER_MUTATION);
const assetFieldTypeSchema = z.enum([
  'HEADLINE',
  'LONG_HEADLINE',
  'DESCRIPTION',
  'BUSINESS_NAME',
  'MARKETING_IMAGE',
  'SQUARE_MARKETING_IMAGE',
  'PORTRAIT_MARKETING_IMAGE',
  'LOGO',
  'LANDSCAPE_LOGO',
  'YOUTUBE_VIDEO',
  'CALL_TO_ACTION_SELECTION',
]);
const assetGroupSignalSchema = z.object({
  type: z.enum(['SEARCH_THEME', 'AUDIENCE']),
  text: z.string().min(1).max(50).optional().describe('Search theme text, required when type=SEARCH_THEME'),
  audience_id: z.string().regex(/^\d+$/).optional().describe('Audience ID, required when type=AUDIENCE'),
});
const listingGroupFilterTypeSchema = z.enum(['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED']);
const listingGroupSourceSchema = z.enum(['SHOPPING', 'WEBPAGE']);
const listingGroupCaseValueSchema = z.union([
  z.object({
    kind: z.literal('PRODUCT_BRAND'),
    value: z.string().min(1).max(60),
  }),
  z.object({
    kind: z.literal('PRODUCT_CATEGORY'),
    level: z.enum(['LEVEL1', 'LEVEL2', 'LEVEL3', 'LEVEL4', 'LEVEL5']),
    category_id: z.string().regex(/^\d+$/, 'category_id must be numeric'),
  }),
  z.object({
    kind: z.literal('PRODUCT_CHANNEL'),
    channel: z.enum(['ONLINE', 'LOCAL']),
  }),
  z.object({
    kind: z.literal('PRODUCT_CONDITION'),
    condition: z.enum(['NEW', 'REFURBISHED', 'USED']),
  }),
  z.object({
    kind: z.literal('PRODUCT_CUSTOM_ATTRIBUTE'),
    index: z.enum(['INDEX0', 'INDEX1', 'INDEX2', 'INDEX3', 'INDEX4']),
    value: z.string().min(1).max(60),
  }),
  z.object({
    kind: z.literal('PRODUCT_ITEM_ID'),
    value: z.string().min(1).max(80),
  }),
  z.object({
    kind: z.literal('PRODUCT_TYPE'),
    level: z.enum(['LEVEL1', 'LEVEL2', 'LEVEL3', 'LEVEL4', 'LEVEL5']),
    value: z.string().min(1).max(60),
  }),
  z.object({
    kind: z.literal('WEBPAGE'),
    conditions: z.array(z.string().min(1)).min(1).max(10),
  }),
]);
const listingGroupNodeSchema = z.object({
  type: listingGroupFilterTypeSchema,
  listing_source: listingGroupSourceSchema.default('WEBPAGE'),
  parent_index: z.number().int().nonnegative().optional(),
  case_value: listingGroupCaseValueSchema.optional(),
});

function validationResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

function validateCustomer(customerId: string) {
  const error = requireCustomerId(customerId);
  return error ? validationResult(error) : null;
}

function normalizeSafeWord(safeWord: string): string {
  return safeWord.trim();
}

function gaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function resourceNameLiteral(value: string): string {
  return `'${gaqlString(value.trim())}'`;
}

function adFilter(sourceAdId?: string, sourceAdGroupAdResourceName?: string): string | null {
  if (sourceAdGroupAdResourceName?.trim()) {
    return `ad_group_ad.resource_name = ${resourceNameLiteral(sourceAdGroupAdResourceName)}`;
  }
  if (sourceAdId?.trim()) {
    return `ad_group_ad.ad.id = ${normalizeResourceId(sourceAdId)}`;
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

function assetIds(items: Array<{ asset?: string }> | undefined): string[] {
  return (items ?? [])
    .map((item) => assetIdFromResourceName(item.asset))
    .filter((value): value is string => Boolean(value));
}

function buildCloneAdQuery(filter: string) {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      ad_group.id,
      ad_group.name,
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

function validateResponsiveSearchInput(headlines: string[], descriptions: string[]): string | null {
  if (headlines.length < 3 || headlines.length > 15) return 'Responsive search ad clone needs 3-15 headlines.';
  if (headlines.some((headline) => headline.length > 30)) return 'Responsive search ad headlines must be max 30 chars each.';
  if (descriptions.length < 2 || descriptions.length > 4) return 'Responsive search ad clone needs 2-4 descriptions.';
  if (descriptions.some((description) => description.length > 90)) return 'Responsive search ad descriptions must be max 90 chars each.';
  return null;
}

function validateResponsiveDisplayInput(input: {
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

type ImageInfo = {
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

function inspectImageBuffer(data: Buffer): ImageInfo | null {
  const dimensions = parseImageDimensions(data);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
  return {
    ...dimensions,
    bytes: data.length,
    aspectRatio: Number((dimensions.width / dimensions.height).toFixed(4)),
    warnings: imageWarnings(dimensions.width, dimensions.height, data.length),
  };
}

function formatImageInfo(info: ImageInfo): string[] {
  return [
    `Detected image: ${info.format.toUpperCase()}, ${info.width}x${info.height}, aspect ${info.aspectRatio}, ${info.bytes} bytes`,
    ...info.warnings.map((warning) => `Image note: ${warning}`),
  ];
}

async function fetchImageForPreview(url: string): Promise<{ data: Buffer; contentType: string }> {
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

async function loadImageAssetInfo(cfg: AdsConfig, customerId: string, assetIds: string[]): Promise<Record<string, { width?: number; height?: number; url?: string }>> {
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

function ratioOk(width: number | undefined, height: number | undefined, min: number, max: number): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= min && ratio <= max;
}

function validateAssetPlacement(label: string, assetIds: string[], info: Record<string, { width?: number; height?: number }>, minRatio: number, maxRatio: number): string | null {
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

function safetyHookNotice(cfg: AdsConfig, safeWord?: string) {
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

function prepareResponse(cfg: AdsConfig, mutation: { token: string; safeWord: string }, preview: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        preview,
        token: mutation.token,
        safeWord: mutation.safeWord,
        expiresInSeconds: getTokenTtlSeconds(),
        instruction: `Show the user the preview and ask them to reply with the word "${mutation.safeWord}". Only after such a reply, call confirm_mutation with the token.`,
        safety: safetyHookNotice(cfg, mutation.safeWord),
      }, null, 2),
    }],
  };
}

export function registerWriteTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'get_safety_setup',
    'Explain the current mutation safety model and how to install Codex hooks if plugin-local hooks are not active.',
    {},
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          safetyLevel: cfg.safetyLevel,
          mutationTokenTtlSeconds: getTokenTtlSeconds(),
          manualSafeWordConfirmation: {
            enabled: process.env['GOOGLE_ADS_ENABLE_MANUAL_CONFIRM'] === '1',
            env: 'GOOGLE_ADS_ENABLE_MANUAL_CONFIRM',
            purpose: 'Test-only fallback for confirm_safe_word. Keep this set to 0/unset outside local testing so normal confirmation relies on user-message hooks.',
          },
          serverSideProtection: 'Every write requires a prepare_* token. Tokens are server-side, one-shot, and time-limited.',
          clientHookGate: safetyHookNotice(cfg),
          codex: {
            expectedProblem: 'Codex may show "No plugin hooks" because current Codex runtime loads MCP from plugins but does not reliably activate plugin-local hooks.',
            fix: 'Install the standalone hook package in addition to the plugin.',
            installCommand: CODEX_HOOK_INSTALL_COMMAND,
            afterInstall: 'Restart or refresh Codex, then verify hooks are visible/active before running confirm_mutation.',
          },
        }, null, 2),
      }],
    }),
  );

  server.tool(
    'prepare_campaign_status',
    'Prepare a campaign status change (enable/pause). Returns a preview and confirmation token. The user MUST confirm before the change is applied.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      campaign_id: z.string().describe('Campaign ID'),
      campaign_name: z.string().describe('Campaign name (for preview)'),
      new_status: z.enum(['ENABLED', 'PAUSED']).describe('Target status'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, campaign_name, new_status, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const action = new_status === 'ENABLED' ? 'Enable' : 'Pause';
      const preview = `${action} campaign "${campaign_name}" (ID: ${normalizedCampaignId}) on account ${normalizedCustomerId}`;
      const mutation = createToken('campaign_status', { customer_id: normalizedCustomerId, campaign_id: normalizedCampaignId, new_status }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_campaign_removal',
    'Prepare removal of one or more campaigns. Returns a preview and confirmation token. The user MUST confirm before the change is applied.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      campaigns: z.array(campaignRefSchema).min(1).max(20).describe('Campaigns to remove'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaigns, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaigns = campaigns.map((campaign) => ({
        campaign_id: normalizeResourceId(campaign.campaign_id),
        campaign_name: campaign.campaign_name,
      }));
      const preview = [
        `Remove ${normalizedCampaigns.length} campaign(s) on account ${normalizedCustomerId}:`,
        ...normalizedCampaigns.map((campaign) => `- "${campaign.campaign_name}" (ID: ${campaign.campaign_id})`),
      ].join('\n');
      const mutation = createToken('campaign_removal', {
        customer_id: normalizedCustomerId,
        campaigns: normalizedCampaigns,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_budget_change',
    'Prepare a campaign budget change. Returns a preview and confirmation token. The user MUST confirm before the change is applied.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      budget_id: z.string().describe('Campaign budget resource ID'),
      campaign_name: z.string().describe('Campaign name (for preview)'),
      current_budget_pln: z.number().describe('Current daily budget in PLN'),
      new_budget_pln: z.number().describe('New daily budget in PLN'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, budget_id, campaign_name, current_budget_pln, new_budget_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const newMicros = Math.round(new_budget_pln * 1_000_000);
      if (newMicros > MAX_BUDGET_MICROS) {
        return {
          content: [{
            type: 'text',
            text: `Error: Budget ${new_budget_pln} PLN exceeds the safety limit (${MAX_BUDGET_MICROS / 1_000_000} PLN/day).`,
          }],
        };
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedBudgetId = normalizeResourceId(budget_id);
      const preview = `Change budget of campaign "${campaign_name}": ${current_budget_pln} -> ${new_budget_pln} PLN/day (account ${normalizedCustomerId})`;
      const mutation = createToken('budget_change', { customer_id: normalizedCustomerId, budget_id: normalizedBudgetId, amount_micros: newMicros }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_image_asset_from_file',
    'Prepare upload of an image asset from a local file path. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      asset_name: z.string().min(1).max(255).describe('Name for the new image asset'),
      file_path: z.string().min(1).describe('Absolute or relative local file path'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, asset_name, file_path, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      let info: ImageInfo | null = null;
      try {
        const st = statSync(file_path);
        if (!st.isFile()) return validationResult(`Path is not a file: ${file_path}`);
        if (st.size <= 0) return validationResult(`File is empty: ${file_path}`);
        if (st.size > MAX_IMAGE_BYTES) return validationResult(`File is too large (${st.size} bytes). Max allowed: ${MAX_IMAGE_BYTES} bytes.`);
        info = inspectImageBuffer(readFileSync(file_path));
        if (!info) return validationResult('File does not look like a supported image with readable dimensions.');
      } catch (err: any) {
        return validationResult(err?.message || `Cannot inspect file: ${file_path}`);
      }
      const preview = [
        `Upload image asset "${asset_name}" on account ${normalizedCustomerId}`,
        `Source file: ${file_path}`,
        `Safety cap: max ${MAX_IMAGE_BYTES} bytes`,
        ...formatImageInfo(info),
      ].join('\n');
      const mutation = createToken('image_asset_upload_from_file', {
        customer_id: normalizedCustomerId,
        asset_name,
        file_path,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_image_asset_from_url',
    'Prepare upload of an image asset from a public URL. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      asset_name: z.string().min(1).max(255).describe('Name for the new image asset'),
      image_url: z.string().url().describe('Public image URL'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, asset_name, image_url, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      let info: ImageInfo | null = null;
      let contentType = 'unknown';
      try {
        const previewImage = await fetchImageForPreview(image_url);
        contentType = previewImage.contentType;
        if (!contentType.toLowerCase().startsWith('image/')) {
          return validationResult(`URL does not look like an image (content-type: ${contentType}).`);
        }
        info = inspectImageBuffer(previewImage.data);
        if (!info) return validationResult('URL image does not have readable dimensions.');
      } catch (err: any) {
        return validationResult(err?.message || `Cannot inspect URL image: ${image_url}`);
      }
      const preview = [
        `Upload image asset "${asset_name}" on account ${normalizedCustomerId}`,
        `Source URL: ${image_url}`,
        `Content-Type: ${contentType}`,
        `Safety cap: max ${MAX_IMAGE_BYTES} bytes`,
        ...formatImageInfo(info),
      ].join('\n');
      const mutation = createToken('image_asset_upload_from_url', {
        customer_id: normalizedCustomerId,
        asset_name,
        image_url,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_search_campaign',
    'Prepare creation of a paused Search campaign with a daily budget. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_name: z.string().min(1).describe('New campaign name'),
      daily_budget_pln: z.number().positive().describe('Daily budget in PLN; capped by server safety limit'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_name, daily_budget_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const budgetMicros = Math.round(daily_budget_pln * 1_000_000);
      if (budgetMicros > MAX_BUDGET_MICROS) {
        return validationResult(`Budget ${daily_budget_pln} PLN exceeds the safety limit (${MAX_BUDGET_MICROS / 1_000_000} PLN/day).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const preview = `Create paused Search campaign "${campaign_name}" with budget ${daily_budget_pln} PLN/day on account ${normalizedCustomerId}`;
      const mutation = createToken('search_campaign_create', {
        customer_id: normalizedCustomerId,
        campaign_name,
        daily_budget_micros: budgetMicros,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_display_campaign',
    'Prepare creation of a paused Display campaign with a daily budget. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_name: z.string().min(1).describe('New campaign name'),
      daily_budget_pln: z.number().positive().describe('Daily budget in PLN; capped by server safety limit'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_name, daily_budget_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const budgetMicros = Math.round(daily_budget_pln * 1_000_000);
      if (budgetMicros > MAX_BUDGET_MICROS) {
        return validationResult(`Budget ${daily_budget_pln} PLN exceeds the safety limit (${MAX_BUDGET_MICROS / 1_000_000} PLN/day).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const preview = `Create paused Display campaign "${campaign_name}" with budget ${daily_budget_pln} PLN/day on account ${normalizedCustomerId}`;
      const mutation = createToken('display_campaign_create', {
        customer_id: normalizedCustomerId,
        campaign_name,
        daily_budget_micros: budgetMicros,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_performance_max_campaign',
    'Prepare creation of a paused Performance Max campaign with a daily budget. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_name: z.string().min(1).describe('New campaign name'),
      daily_budget_pln: z.number().positive().describe('Daily budget in PLN; capped by server safety limit'),
      business_name_asset_id: z.string().optional().describe('Optional existing TEXT asset ID for PMax brand guidelines business name'),
      logo_asset_id: z.string().optional().describe('Optional existing square IMAGE asset ID for PMax brand guidelines logo'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_name, daily_budget_pln, business_name_asset_id, logo_asset_id, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const budgetMicros = Math.round(daily_budget_pln * 1_000_000);
      if (budgetMicros > MAX_BUDGET_MICROS) {
        return validationResult(`Budget ${daily_budget_pln} PLN exceeds the safety limit (${MAX_BUDGET_MICROS / 1_000_000} PLN/day).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedBusinessNameAssetId = business_name_asset_id ? normalizeResourceId(business_name_asset_id) : undefined;
      const normalizedLogoAssetId = logo_asset_id ? normalizeResourceId(logo_asset_id) : undefined;
      if (normalizedLogoAssetId) {
        const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, [normalizedLogoAssetId]);
        const placementError = validateAssetPlacement('PMax brand logo', [normalizedLogoAssetId], imageInfo, 0.95, 1.05);
        if (placementError) return validationResult(placementError);
      }
      const preview = [
        `Create paused Performance Max campaign "${campaign_name}" with budget ${daily_budget_pln} PLN/day on account ${normalizedCustomerId}`,
        `Business name asset: ${normalizedBusinessNameAssetId || '(none)'}`,
        `Logo asset: ${normalizedLogoAssetId || '(none)'}`,
      ].join('\n');
      const mutation = createToken('performance_max_campaign_create', {
        customer_id: normalizedCustomerId,
        campaign_name,
        daily_budget_micros: budgetMicros,
        business_name_asset_id: normalizedBusinessNameAssetId,
        logo_asset_id: normalizedLogoAssetId,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_ad_group',
    'Prepare creation of a paused Search ad group under an existing campaign. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing campaign ID'),
      ad_group_name: z.string().min(1).describe('New ad group name'),
      cpc_bid_pln: z.number().positive().describe('Max CPC bid in PLN; capped by server safety limit'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, ad_group_name, cpc_bid_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const cpcMicros = Math.round(cpc_bid_pln * 1_000_000);
      if (cpcMicros > MAX_CPC_MICROS) {
        return validationResult(`CPC bid ${cpc_bid_pln} PLN exceeds the safety limit (${MAX_CPC_MICROS / 1_000_000} PLN).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const preview = `Create paused ad group "${ad_group_name}" in campaign ${normalizedCampaignId}, max CPC ${cpc_bid_pln} PLN, account ${normalizedCustomerId}`;
      const mutation = createToken('ad_group_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        ad_group_name,
        cpc_bid_micros: cpcMicros,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_display_ad_group',
    'Prepare creation of a paused Display ad group under an existing campaign. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing campaign ID'),
      ad_group_name: z.string().min(1).describe('New ad group name'),
      cpc_bid_pln: z.number().positive().describe('Max CPC bid in PLN; capped by server safety limit'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, ad_group_name, cpc_bid_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const cpcMicros = Math.round(cpc_bid_pln * 1_000_000);
      if (cpcMicros > MAX_CPC_MICROS) {
        return validationResult(`CPC bid ${cpc_bid_pln} PLN exceeds the safety limit (${MAX_CPC_MICROS / 1_000_000} PLN).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const preview = `Create paused Display ad group "${ad_group_name}" in campaign ${normalizedCampaignId}, max CPC ${cpc_bid_pln} PLN, account ${normalizedCustomerId}`;
      const mutation = createToken('display_ad_group_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        ad_group_name,
        cpc_bid_micros: cpcMicros,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_asset_group',
    'Prepare creation of a paused Performance Max asset group under an existing campaign. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing Performance Max campaign ID'),
      asset_group_name: z.string().min(1).describe('New asset group name'),
      final_urls: z.array(z.string().url()).min(1).max(20).describe('Landing page final URLs for the asset group'),
      assets: z.array(z.object({
        asset_id: z.string().describe('Existing asset ID'),
        field_type: assetFieldTypeSchema.describe('Asset group field type, e.g. HEADLINE, MARKETING_IMAGE, YOUTUBE_VIDEO'),
      })).min(1).max(MAX_ASSET_GROUP_ASSETS_PER_MUTATION).describe('Existing assets to link while creating the asset group. PMax requires core creative assets at creation time.'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, asset_group_name, final_urls, assets, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const normalizedAssets = assets.map((asset) => ({
        asset_id: normalizeResourceId(asset.asset_id),
        field_type: asset.field_type,
      }));
      const unique = new Set(normalizedAssets.map((asset) => `${asset.asset_id}:${asset.field_type}`));
      if (unique.size !== normalizedAssets.length) return validationResult('Duplicate asset group asset links in request.');
      const countByField = (field: string) => normalizedAssets.filter((asset) => asset.field_type === field).length;
      if (countByField('HEADLINE') < 3) return validationResult('Performance Max asset groups require at least 3 HEADLINE assets.');
      if (countByField('LONG_HEADLINE') < 1) return validationResult('Performance Max asset groups require at least 1 LONG_HEADLINE asset.');
      if (countByField('DESCRIPTION') < 2) return validationResult('Performance Max asset groups require at least 2 DESCRIPTION assets.');
      if (countByField('MARKETING_IMAGE') < 1) return validationResult('Performance Max asset groups require at least 1 MARKETING_IMAGE asset.');
      if (countByField('SQUARE_MARKETING_IMAGE') < 1) return validationResult('Performance Max asset groups require at least 1 SQUARE_MARKETING_IMAGE asset.');
      const imageAssets = normalizedAssets.filter((asset) => ['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO'].includes(asset.field_type));
      const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, imageAssets.map((asset) => asset.asset_id));
      const byField = (field: string) => imageAssets.filter((asset) => asset.field_type === field).map((asset) => asset.asset_id);
      const placementError = validateAssetPlacement('Marketing image', byField('MARKETING_IMAGE'), imageInfo, 1.75, 2.05)
        || validateAssetPlacement('Square marketing image', byField('SQUARE_MARKETING_IMAGE'), imageInfo, 0.95, 1.05)
        || validateAssetPlacement('Portrait marketing image', byField('PORTRAIT_MARKETING_IMAGE'), imageInfo, 0.75, 0.85)
        || validateAssetPlacement('Logo', byField('LOGO'), imageInfo, 0.95, 5.0)
        || validateAssetPlacement('Landscape logo', byField('LANDSCAPE_LOGO'), imageInfo, 3.0, 5.0);
      if (placementError) return validationResult(placementError);
      const preview = [
        `Create paused asset group "${asset_group_name}" in campaign ${normalizedCampaignId}, account ${normalizedCustomerId}`,
        `Final URLs: ${final_urls.join(', ')}`,
        `Assets (${normalizedAssets.length}):`,
        ...normalizedAssets.map((asset) => `- ${asset.field_type}: ${asset.asset_id}`),
      ].join('\n');
      const mutation = createToken('asset_group_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        asset_group_name,
        final_urls,
        assets: normalizedAssets,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_responsive_search_ad',
    'Prepare creation of a paused responsive search ad under an existing ad group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Existing ad group ID'),
      headlines: z.array(z.string().min(1).max(30)).min(3).max(15).describe('3-15 responsive search ad headlines, max 30 chars each'),
      descriptions: z.array(z.string().min(1).max(90)).min(2).max(4).describe('2-4 responsive search ad descriptions, max 90 chars each'),
      final_url: z.string().url().describe('Landing page URL'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, ad_group_id, headlines, descriptions, final_url, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const preview = [
        `Create paused responsive search ad in ad group ${normalizedAdGroupId}, account ${normalizedCustomerId}`,
        `Final URL: ${final_url}`,
        `Headlines: ${headlines.join(' | ')}`,
        `Descriptions: ${descriptions.join(' | ')}`,
      ].join('\n');
      const mutation = createToken('responsive_search_ad_create', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        headlines,
        descriptions,
        final_url,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_responsive_display_ad',
    'Prepare creation of a paused responsive display ad under an existing ad group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Existing ad group ID'),
      business_name: z.string().min(1).max(25).describe('Business name, max 25 chars'),
      headlines: z.array(z.string().min(1).max(30)).min(1).max(5).describe('1-5 short headlines, max 30 chars each'),
      long_headline: z.string().min(1).max(90).describe('Long headline, max 90 chars'),
      descriptions: z.array(z.string().min(1).max(90)).min(1).max(5).describe('1-5 descriptions, max 90 chars each'),
      final_url: z.string().url().describe('Landing page URL'),
      marketing_image_asset_ids: displayAssetIdListSchema.describe('1-15 IMAGE asset IDs, e.g. ["123","456"]'),
      square_marketing_image_asset_ids: displayAssetIdListSchema.describe('1-15 square IMAGE asset IDs'),
      logo_image_asset_ids: displayLogoAssetIdListSchema.describe('Optional logo IMAGE asset IDs, up to 5'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({
      customer_id,
      ad_group_id,
      business_name,
      headlines,
      long_headline,
      descriptions,
      final_url,
      marketing_image_asset_ids,
      square_marketing_image_asset_ids,
      logo_image_asset_ids,
      safe_word,
    }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const normalizedMarketingImageAssetIds = marketing_image_asset_ids.map(normalizeResourceId);
      const normalizedSquareMarketingImageAssetIds = square_marketing_image_asset_ids.map(normalizeResourceId);
      const normalizedLogoImageAssetIds = logo_image_asset_ids.map(normalizeResourceId);
      const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, [
        ...normalizedMarketingImageAssetIds,
        ...normalizedSquareMarketingImageAssetIds,
        ...normalizedLogoImageAssetIds,
      ]);
      const placementError = validateAssetPlacement('Marketing image', normalizedMarketingImageAssetIds, imageInfo, 1.75, 2.05)
        || validateAssetPlacement('Square marketing image', normalizedSquareMarketingImageAssetIds, imageInfo, 0.95, 1.05)
        || validateAssetPlacement('Logo image', normalizedLogoImageAssetIds, imageInfo, 1.0, 5.0);
      if (placementError) return validationResult(placementError);
      const preview = [
        `Create paused responsive display ad in ad group ${normalizedAdGroupId}, account ${normalizedCustomerId}`,
        `Final URL: ${final_url}`,
        `Business name: ${business_name}`,
        `Headlines (${headlines.length}): ${headlines.join(' | ')}`,
        `Long headline: ${long_headline}`,
        `Descriptions (${descriptions.length}): ${descriptions.join(' | ')}`,
        `Marketing image assets: ${normalizedMarketingImageAssetIds.join(', ')}`,
        `Square marketing image assets: ${normalizedSquareMarketingImageAssetIds.join(', ')}`,
        `Logo image assets: ${normalizedLogoImageAssetIds.length ? normalizedLogoImageAssetIds.join(', ') : '(none)'}`,
      ].join('\n');
      const mutation = createToken('responsive_display_ad_create', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        business_name,
        headlines,
        long_headline,
        descriptions,
        final_url,
        marketing_image_asset_ids: normalizedMarketingImageAssetIds,
        square_marketing_image_asset_ids: normalizedSquareMarketingImageAssetIds,
        logo_image_asset_ids: normalizedLogoImageAssetIds,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_keywords',
    'Prepare creation of enabled search keywords in an existing ad group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Existing Search ad group ID'),
      keywords: z.array(keywordSchema).min(1).max(MAX_KEYWORDS_PER_MUTATION).describe('Keywords to add, each with text and match_type BROAD, PHRASE, or EXACT'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, ad_group_id, keywords, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const normalizedKeywords = keywords.map((keyword) => ({
        text: keyword.text.trim(),
        match_type: keyword.match_type,
      }));
      const uniqueKeys = new Set(normalizedKeywords.map((keyword) => `${keyword.match_type}:${keyword.text.toLowerCase()}`));
      if (uniqueKeys.size !== normalizedKeywords.length) {
        return validationResult('Duplicate keywords in the request. Remove duplicates before prepare.');
      }
      const preview = [
        `Create ${normalizedKeywords.length} enabled keyword(s) in ad group ${normalizedAdGroupId}, account ${normalizedCustomerId}`,
        ...normalizedKeywords.map((keyword) => `- ${keyword.match_type}: ${keyword.text}`),
      ].join('\n');
      const mutation = createToken('keywords_create', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        keywords: normalizedKeywords,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_negative_keywords',
    'Prepare creation of negative keywords at campaign or ad group level. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      level: negativeKeywordLevelSchema.describe('Where to add negatives: campaign or ad_group'),
      campaign_id: z.string().optional().describe('Campaign ID, required when level=campaign'),
      ad_group_id: z.string().optional().describe('Ad group ID, required when level=ad_group'),
      keywords: z.array(keywordSchema).min(1).max(MAX_KEYWORDS_PER_MUTATION).describe('Negative keywords to add, each with text and match_type BROAD, PHRASE, or EXACT'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, level, campaign_id, ad_group_id, keywords, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if (level === 'campaign' && !campaign_id) return validationResult('campaign_id is required when level=campaign.');
      if (level === 'ad_group' && !ad_group_id) return validationResult('ad_group_id is required when level=ad_group.');
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = campaign_id ? normalizeResourceId(campaign_id) : undefined;
      const normalizedAdGroupId = ad_group_id ? normalizeResourceId(ad_group_id) : undefined;
      const targetId = level === 'campaign' ? normalizedCampaignId : normalizedAdGroupId;
      const normalizedKeywords = keywords.map((keyword) => ({
        text: keyword.text.trim(),
        match_type: keyword.match_type,
      }));
      const uniqueKeys = new Set(normalizedKeywords.map((keyword) => `${keyword.match_type}:${keyword.text.toLowerCase()}`));
      if (uniqueKeys.size !== normalizedKeywords.length) {
        return validationResult('Duplicate negative keywords in the request. Remove duplicates before prepare.');
      }
      const preview = [
        `Create ${normalizedKeywords.length} negative keyword(s) at ${level} ${targetId}, account ${normalizedCustomerId}`,
        ...normalizedKeywords.map((keyword) => `- ${keyword.match_type}: ${keyword.text}`),
      ].join('\n');
      const mutation = createToken('negative_keywords_create', {
        customer_id: normalizedCustomerId,
        level,
        campaign_id: normalizedCampaignId,
        ad_group_id: normalizedAdGroupId,
        keywords: normalizedKeywords,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_campaign_targeting',
    'Prepare adding location and language targeting criteria to a campaign. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing campaign ID'),
      location_criterion_ids: criterionIdListSchema.default([]).describe('Geo target constant criterion IDs, e.g. 2616 for Poland'),
      language_criterion_ids: criterionIdListSchema.default([]).describe('Language constant criterion IDs, e.g. 1045 for Polish, 1000 for English'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, location_criterion_ids, language_criterion_ids, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if (location_criterion_ids.length + language_criterion_ids.length < 1) {
        return validationResult('Provide at least one location_criterion_id or language_criterion_id.');
      }
      if (location_criterion_ids.length + language_criterion_ids.length > MAX_TARGETING_CRITERIA_PER_MUTATION) {
        return validationResult(`Too many targeting criteria. Max ${MAX_TARGETING_CRITERIA_PER_MUTATION}.`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const uniqueLocations = [...new Set(location_criterion_ids.map(normalizeResourceId))];
      const uniqueLanguages = [...new Set(language_criterion_ids.map(normalizeResourceId))];
      const preview = [
        `Add campaign targeting to campaign ${normalizedCampaignId}, account ${normalizedCustomerId}`,
        `Location criterion IDs: ${uniqueLocations.length ? uniqueLocations.join(', ') : '(none)'}`,
        `Language criterion IDs: ${uniqueLanguages.length ? uniqueLanguages.join(', ') : '(none)'}`,
      ].join('\n');
      const mutation = createToken('campaign_targeting_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        location_criterion_ids: uniqueLocations,
        language_criterion_ids: uniqueLanguages,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_asset_group_assets',
    'Prepare linking existing assets to a Performance Max asset group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      asset_group_id: z.string().describe('Existing asset group ID'),
      assets: z.array(z.object({
        asset_id: z.string().describe('Existing asset ID'),
        field_type: assetFieldTypeSchema.describe('Asset group field type, e.g. HEADLINE, MARKETING_IMAGE, YOUTUBE_VIDEO'),
      })).min(1).max(MAX_ASSET_GROUP_ASSETS_PER_MUTATION).describe('Assets to link to the asset group'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, asset_group_id, assets, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAssetGroupId = normalizeResourceId(asset_group_id);
      const normalizedAssets = assets.map((asset) => ({
        asset_id: normalizeResourceId(asset.asset_id),
        field_type: asset.field_type,
      }));
      const unique = new Set(normalizedAssets.map((asset) => `${asset.asset_id}:${asset.field_type}`));
      if (unique.size !== normalizedAssets.length) return validationResult('Duplicate asset group asset links in request.');

      const imageAssets = normalizedAssets.filter((asset) => ['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO'].includes(asset.field_type));
      const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, imageAssets.map((asset) => asset.asset_id));
      const byField = (field: string) => imageAssets.filter((asset) => asset.field_type === field).map((asset) => asset.asset_id);
      const placementError = validateAssetPlacement('Marketing image', byField('MARKETING_IMAGE'), imageInfo, 1.75, 2.05)
        || validateAssetPlacement('Square marketing image', byField('SQUARE_MARKETING_IMAGE'), imageInfo, 0.95, 1.05)
        || validateAssetPlacement('Portrait marketing image', byField('PORTRAIT_MARKETING_IMAGE'), imageInfo, 0.75, 0.85)
        || validateAssetPlacement('Logo', byField('LOGO'), imageInfo, 0.95, 5.0)
        || validateAssetPlacement('Landscape logo', byField('LANDSCAPE_LOGO'), imageInfo, 3.0, 5.0);
      if (placementError) return validationResult(placementError);

      const preview = [
        `Link ${normalizedAssets.length} asset(s) to asset group ${normalizedAssetGroupId}, account ${normalizedCustomerId}`,
        ...normalizedAssets.map((asset) => `- ${asset.field_type}: ${asset.asset_id}`),
      ].join('\n');
      const mutation = createToken('asset_group_assets_create', {
        customer_id: normalizedCustomerId,
        asset_group_id: normalizedAssetGroupId,
        assets: normalizedAssets,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_asset_group_signals',
    'Prepare linking asset group signals to a Performance Max asset group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      asset_group_id: z.string().describe('Existing asset group ID'),
      signals: z.array(assetGroupSignalSchema).min(1).max(MAX_ASSET_GROUP_SIGNALS_PER_MUTATION).describe('Signals to link to the asset group. Supported types: SEARCH_THEME and AUDIENCE.'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, asset_group_id, signals, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAssetGroupId = normalizeResourceId(asset_group_id);
      const normalizedSignals = signals.map((signal) => ({
        type: signal.type,
        text: signal.text?.trim(),
        audience_id: signal.audience_id ? normalizeResourceId(signal.audience_id) : undefined,
      }));
      for (const signal of normalizedSignals) {
        if (signal.type === 'SEARCH_THEME' && !signal.text) return validationResult('SEARCH_THEME signals require text.');
        if (signal.type === 'AUDIENCE' && !signal.audience_id) return validationResult('AUDIENCE signals require audience_id.');
      }
      const unique = new Set(normalizedSignals.map((signal) => signal.type === 'SEARCH_THEME'
        ? `${signal.type}:${signal.text?.toLowerCase()}`
        : `${signal.type}:${signal.audience_id}`));
      if (unique.size !== normalizedSignals.length) return validationResult('Duplicate asset group signals in request.');
      const preview = [
        `Link ${normalizedSignals.length} signal(s) to asset group ${normalizedAssetGroupId}, account ${normalizedCustomerId}`,
        ...normalizedSignals.map((signal) => (
          signal.type === 'SEARCH_THEME'
            ? `- SEARCH_THEME: ${signal.text}`
            : `- AUDIENCE: ${signal.audience_id}`
        )),
      ].join('\n');
      const mutation = createToken('asset_group_signals_create', {
        customer_id: normalizedCustomerId,
        asset_group_id: normalizedAssetGroupId,
        signals: normalizedSignals,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_asset_group_listing_groups',
    'Prepare creation of Performance Max asset group listing group trees. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      asset_group_id: z.string().describe('Existing asset group ID'),
      nodes: z.array(listingGroupNodeSchema).min(2).max(MAX_ASSET_GROUP_LISTING_GROUP_NODES_PER_MUTATION).describe('Tree nodes in parent-first order. Node 0 must be the root subdivision.'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, asset_group_id, nodes, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAssetGroupId = normalizeResourceId(asset_group_id);
      if (nodes[0]?.type !== 'SUBDIVISION') {
        return validationResult('The first listing group node must be a SUBDIVISION root.');
      }
      if (nodes[0]?.parent_index !== undefined) {
        return validationResult('The root listing group node cannot have a parent_index.');
      }
      if (nodes[0]?.case_value) {
        return validationResult('The root listing group node cannot define a case_value.');
      }
      for (let index = 1; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.parent_index === undefined) {
          return validationResult(`Listing group node ${index} is missing parent_index.`);
        }
        if (node.parent_index >= index) {
          return validationResult(`Listing group node ${index} must point to an earlier parent_index.`);
        }
        if (!node.case_value) {
          return validationResult(`Listing group node ${index} must define a case_value.`);
        }
      }
      const normalizedNodes = nodes.map((node) => ({
        type: node.type,
        listing_source: node.listing_source,
        parent_index: node.parent_index,
        case_value: node.case_value,
      }));
      const preview = [
        `Create listing group tree with ${normalizedNodes.length} node(s) in asset group ${normalizedAssetGroupId}, account ${normalizedCustomerId}`,
        ...normalizedNodes.map((node, index) => {
          const parent = node.parent_index === undefined ? 'root' : `parent ${node.parent_index}`;
          const caseValue = node.case_value ? JSON.stringify(node.case_value) : '(none)';
          return `- [${index}] ${node.type} / ${node.listing_source} / ${parent} / ${caseValue}`;
        }),
      ].join('\n');
      const mutation = createToken('asset_group_listing_group_filters_create', {
        customer_id: normalizedCustomerId,
        asset_group_id: normalizedAssetGroupId,
        nodes: normalizedNodes,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_clone_entity',
    'Prepare cloning a supported Google Ads entity as paused. Currently supports entity="ad" for responsive search/display ads.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      entity: cloneEntitySchema.describe('Entity kind to clone. Currently only ad is implemented.'),
      source_ad_id: z.string().optional().describe('Source ad ID. Use this or source_ad_group_ad_resource_name for entity=ad.'),
      source_ad_group_ad_resource_name: z.string().optional().describe('Full source ad group ad resource name, e.g. customers/123/adGroupAds/456~789. Preferred for entity=ad.'),
      target_ad_group_id: z.string().optional().describe('Target ad group ID. Defaults to the source ad group for entity=ad.'),
      final_url: z.string().url().optional().describe('Optional replacement landing page URL. Defaults to the source ad final URL.'),
      business_name: z.string().min(1).max(25).optional().describe('Optional replacement business name for responsive display ads.'),
      headlines: z.array(z.string().min(1)).optional().describe('Optional replacement headlines. Required counts depend on ad type.'),
      long_headline: z.string().min(1).max(90).optional().describe('Optional replacement long headline for responsive display ads.'),
      descriptions: z.array(z.string().min(1)).optional().describe('Optional replacement descriptions. Required counts depend on ad type.'),
      marketing_image_asset_ids: z.array(z.string()).optional().describe('Optional replacement marketing image asset IDs for responsive display ads.'),
      square_marketing_image_asset_ids: z.array(z.string()).optional().describe('Optional replacement square marketing image asset IDs for responsive display ads.'),
      logo_image_asset_ids: z.array(z.string()).optional().describe('Optional replacement logo image asset IDs for responsive display ads.'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({
      customer_id,
      entity,
      source_ad_id,
      source_ad_group_ad_resource_name,
      target_ad_group_id,
      final_url,
      business_name,
      headlines,
      long_headline,
      descriptions,
      marketing_image_asset_ids,
      square_marketing_image_asset_ids,
      logo_image_asset_ids,
      safe_word,
    }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if (entity !== 'ad') {
        return validationResult(`Cloning ${entity} is not implemented yet. Use entity="ad".`);
      }

      const filter = adFilter(source_ad_id, source_ad_group_ad_resource_name);
      if (!filter) return validationResult('Provide source_ad_id or source_ad_group_ad_resource_name.');

      try {
        const normalizedCustomerId = normalizeCustomerId(customer_id);
        const rows = await executeGaql(cfg, normalizedCustomerId, buildCloneAdQuery(filter)) as any[];
        if (rows.length === 0) return validationResult('Source ad not found.');
        if (rows.length > 1) return validationResult('More than one source ad matched. Retry with source_ad_group_ad_resource_name.');

        const row = rows[0];
        const ad = row.ad_group_ad?.ad ?? {};
        const sourceAdGroupId = String(row.ad_group?.id ?? '');
        const normalizedTargetAdGroupId = normalizeResourceId(target_ad_group_id || sourceAdGroupId);
        const resolvedFinalUrl = final_url || ad.final_urls?.[0];
        if (!resolvedFinalUrl) return validationResult('Source ad has no final URL. Provide final_url override.');

        const responsiveDisplay = ad.responsive_display_ad;
        const responsiveSearch = ad.responsive_search_ad;

        if (responsiveDisplay) {
          const resolved = {
            businessName: business_name || responsiveDisplay.business_name,
            headlines: headlines || textValues(responsiveDisplay.headlines),
            longHeadline: long_headline || responsiveDisplay.long_headline?.text,
            descriptions: descriptions || textValues(responsiveDisplay.descriptions),
            marketingImageAssetIds: (marketing_image_asset_ids || assetIds(responsiveDisplay.marketing_images)).map(normalizeResourceId),
            squareMarketingImageAssetIds: (square_marketing_image_asset_ids || assetIds(responsiveDisplay.square_marketing_images)).map(normalizeResourceId),
            logoImageAssetIds: (logo_image_asset_ids || assetIds(responsiveDisplay.logo_images)).map(normalizeResourceId),
          };
          const validationError = validateResponsiveDisplayInput(resolved);
          if (validationError) return validationResult(validationError);
          const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, [
            ...resolved.marketingImageAssetIds,
            ...resolved.squareMarketingImageAssetIds,
            ...resolved.logoImageAssetIds,
          ]);
          const placementError = validateAssetPlacement('Marketing image', resolved.marketingImageAssetIds, imageInfo, 1.75, 2.05)
            || validateAssetPlacement('Square marketing image', resolved.squareMarketingImageAssetIds, imageInfo, 0.95, 1.05)
            || validateAssetPlacement('Logo image', resolved.logoImageAssetIds, imageInfo, 1.0, 5.0);
          if (placementError) return validationResult(placementError);

          const preview = [
            `Clone responsive display ad ${ad.id} into paused ad in ad group ${normalizedTargetAdGroupId}, account ${normalizedCustomerId}`,
            `Source: ${row.ad_group_ad?.resource_name}`,
            `Final URL: ${resolvedFinalUrl}`,
            `Business name: ${resolved.businessName}`,
            `Headlines (${resolved.headlines.length}): ${resolved.headlines.join(' | ')}`,
            `Long headline: ${resolved.longHeadline}`,
            `Descriptions (${resolved.descriptions.length}): ${resolved.descriptions.join(' | ')}`,
            `Marketing image assets: ${resolved.marketingImageAssetIds.join(', ')}`,
            `Square marketing image assets: ${resolved.squareMarketingImageAssetIds.join(', ')}`,
            `Logo image assets: ${resolved.logoImageAssetIds.length ? resolved.logoImageAssetIds.join(', ') : '(none)'}`,
          ].join('\n');
          const mutation = createToken('responsive_display_ad_create', {
            customer_id: normalizedCustomerId,
            ad_group_id: normalizedTargetAdGroupId,
            business_name: resolved.businessName,
            headlines: resolved.headlines,
            long_headline: resolved.longHeadline,
            descriptions: resolved.descriptions,
            final_url: resolvedFinalUrl,
            marketing_image_asset_ids: resolved.marketingImageAssetIds,
            square_marketing_image_asset_ids: resolved.squareMarketingImageAssetIds,
            logo_image_asset_ids: resolved.logoImageAssetIds,
          }, preview, normalizeSafeWord(safe_word));
          return prepareResponse(cfg, mutation, preview);
        }

        if (responsiveSearch) {
          const resolvedHeadlines = headlines || textValues(responsiveSearch.headlines);
          const resolvedDescriptions = descriptions || textValues(responsiveSearch.descriptions);
          const validationError = validateResponsiveSearchInput(resolvedHeadlines, resolvedDescriptions);
          if (validationError) return validationResult(validationError);

          const preview = [
            `Clone responsive search ad ${ad.id} into paused ad in ad group ${normalizedTargetAdGroupId}, account ${normalizedCustomerId}`,
            `Source: ${row.ad_group_ad?.resource_name}`,
            `Final URL: ${resolvedFinalUrl}`,
            `Headlines (${resolvedHeadlines.length}): ${resolvedHeadlines.join(' | ')}`,
            `Descriptions (${resolvedDescriptions.length}): ${resolvedDescriptions.join(' | ')}`,
          ].join('\n');
          const mutation = createToken('responsive_search_ad_create', {
            customer_id: normalizedCustomerId,
            ad_group_id: normalizedTargetAdGroupId,
            headlines: resolvedHeadlines,
            descriptions: resolvedDescriptions,
            final_url: resolvedFinalUrl,
          }, preview, normalizeSafeWord(safe_word));
          return prepareResponse(cfg, mutation, preview);
        }

        return validationResult(`Unsupported source ad type: ${ad.type ?? 'unknown'}. Currently supported: responsive search and responsive display ads.`);
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'confirm_safe_word',
    'Test-only fallback for confirming a safe word when GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1. Normal use should rely on user-message hooks.',
    {
      token: z.string().describe('Confirmation token from prepare_* response'),
      safe_word: z.string().min(1).describe('Exact safe word shown in prepare_* response'),
    },
    async ({ token, safe_word }) => {
      const result = confirmPendingSafeWord(token, safe_word);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }
      return { content: [{ type: 'text', text: 'OK: Safe word confirmed for this token. You can now call confirm_mutation.' }] };
    },
  );

  server.tool(
    'confirm_mutation',
    'Execute a previously prepared mutation. Requires a valid, non-expired token from a prepare_* call. The user MUST have explicitly confirmed the action.',
    {
      token: z.string().describe('Confirmation token from prepare_* response'),
    },
    async ({ token }) => {
      const pendingMutation = getPendingToken(token);
      if (!pendingMutation) {
        return {
          content: [{ type: 'text', text: 'Error: Token is invalid or expired. Prepare the operation again using prepare_*.' }],
        };
      }

      const confirmState = consumeConfirmState(pendingMutation);
      if (!confirmState.ok) {
        return {
          content: [{ type: 'text', text: `Error: ${confirmState.error}` }],
        };
      }

      const mutation = consumeToken(token);
      if (!mutation) {
        return {
          content: [{ type: 'text', text: 'Error: Token is invalid or expired. Prepare the operation again using prepare_*.' }],
        };
      }

      try {
        const p = mutation.params as Record<string, any>;

        if (mutation.action === 'campaign_status') {
          await mutateCampaignStatus(cfg, p.customer_id, p.campaign_id, p.new_status);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.` }] };
        }

        if (mutation.action === 'campaign_removal') {
          const result = await removeCampaigns(
            cfg,
            p.customer_id,
            p.campaigns.map((campaign: any) => campaign.campaign_id),
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'budget_change') {
          await mutateCampaignBudget(cfg, p.customer_id, p.budget_id, p.amount_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.` }] };
        }

        if (mutation.action === 'search_campaign_create') {
          const result = await createSearchCampaign(cfg, p.customer_id, p.campaign_name, p.daily_budget_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'display_campaign_create') {
          const result = await createDisplayCampaign(cfg, p.customer_id, p.campaign_name, p.daily_budget_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'performance_max_campaign_create') {
          const result = await createPerformanceMaxCampaign(cfg, p.customer_id, p.campaign_name, p.daily_budget_micros, {
            businessNameAssetId: p.business_name_asset_id,
            logoAssetId: p.logo_asset_id,
          });
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'ad_group_create') {
          const result = await createAdGroup(cfg, p.customer_id, p.campaign_id, p.ad_group_name, p.cpc_bid_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'display_ad_group_create') {
          const result = await createDisplayAdGroup(cfg, p.customer_id, p.campaign_id, p.ad_group_name, p.cpc_bid_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'asset_group_create') {
          const result = await createAssetGroup(
            cfg,
            p.customer_id,
            p.campaign_id,
            p.asset_group_name,
            p.final_urls,
            p.assets.map((asset: any) => ({
              assetId: asset.asset_id,
              fieldType: asset.field_type,
            })),
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'responsive_search_ad_create') {
          const result = await createResponsiveSearchAd(cfg, p.customer_id, p.ad_group_id, p.headlines, p.descriptions, p.final_url);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'responsive_display_ad_create') {
          const result = await createResponsiveDisplayAd(
            cfg,
            p.customer_id,
            p.ad_group_id,
            p.business_name,
            p.headlines,
            p.long_headline,
            p.descriptions,
            p.final_url,
            p.marketing_image_asset_ids,
            p.square_marketing_image_asset_ids,
            p.logo_image_asset_ids,
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'keywords_create') {
          const result = await createKeywords(
            cfg,
            p.customer_id,
            p.ad_group_id,
            p.keywords.map((keyword: any) => ({
              text: keyword.text,
              matchType: keyword.match_type,
            })),
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'negative_keywords_create') {
          const target = p.level === 'campaign'
            ? { level: 'campaign' as const, campaignId: p.campaign_id }
            : { level: 'ad_group' as const, adGroupId: p.ad_group_id };
          const result = await createNegativeKeywords(
            cfg,
            p.customer_id,
            target,
            p.keywords.map((keyword: any) => ({
              text: keyword.text,
              matchType: keyword.match_type,
            })),
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'campaign_targeting_create') {
          const result = await createCampaignTargeting(
            cfg,
            p.customer_id,
            p.campaign_id,
            {
              locationCriterionIds: p.location_criterion_ids,
              languageCriterionIds: p.language_criterion_ids,
            },
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'asset_group_assets_create') {
          const result = await createAssetGroupAssets(
            cfg,
            p.customer_id,
            p.asset_group_id,
            p.assets.map((asset: any) => ({
              assetId: asset.asset_id,
              fieldType: asset.field_type,
            })),
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'asset_group_signals_create') {
          const result = await createAssetGroupSignals(
            cfg,
            p.customer_id,
            p.asset_group_id,
            p.signals.map((signal: any) => (
              signal.type === 'SEARCH_THEME'
                ? { type: 'SEARCH_THEME' as const, text: signal.text }
                : { type: 'AUDIENCE' as const, audienceId: signal.audience_id }
            )),
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'asset_group_listing_group_filters_create') {
          const result = await createAssetGroupListingGroupFilters(
            cfg,
            p.customer_id,
            p.asset_group_id,
            p.nodes.map((node: any) => {
              if (node.case_value?.kind === 'PRODUCT_BRAND') {
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
                caseValue: {
                  product_brand: { value: node.case_value.value },
                },
                };
              }
              if (node.case_value?.kind === 'PRODUCT_CATEGORY') {
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
                caseValue: {
                  product_category: {
                      category_id: node.case_value.category_id,
                      level: node.case_value.level,
                    },
                  },
                };
              }
              if (node.case_value?.kind === 'PRODUCT_CHANNEL') {
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
                caseValue: {
                  product_channel: { channel: node.case_value.channel },
                  },
                };
              }
              if (node.case_value?.kind === 'PRODUCT_CONDITION') {
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
                caseValue: {
                  product_condition: { condition: node.case_value.condition },
                  },
                };
              }
              if (node.case_value?.kind === 'PRODUCT_CUSTOM_ATTRIBUTE') {
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
                caseValue: {
                  product_custom_attribute: {
                      index: node.case_value.index,
                      value: node.case_value.value,
                    },
                  },
                };
              }
              if (node.case_value?.kind === 'PRODUCT_ITEM_ID') {
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
                caseValue: {
                  product_item_id: { value: node.case_value.value },
                  },
                };
              }
              if (node.case_value?.kind === 'PRODUCT_TYPE') {
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
                caseValue: {
                  product_type: {
                      level: node.case_value.level,
                      value: node.case_value.value,
                    },
                  },
                };
              }
              if (node.case_value?.kind === 'WEBPAGE') {
              return {
                type: node.type,
                parentIndex: node.parent_index,
                caseValue: {
                  webpage: {
                      conditions: node.case_value.conditions,
                    },
                  },
                };
              }
              return {
                type: node.type,
                listingSource: node.listing_source,
                parentIndex: node.parent_index,
              };
            }),
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'image_asset_upload_from_url') {
          const result = await uploadImageAssetFromUrl(
            cfg,
            p.customer_id,
            p.asset_name,
            p.image_url,
            MAX_IMAGE_BYTES,
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'image_asset_upload_from_file') {
          const result = await uploadImageAssetFromFile(
            cfg,
            p.customer_id,
            p.asset_name,
            p.file_path,
            MAX_IMAGE_BYTES,
          );
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}` }] };
        }

        return { content: [{ type: 'text', text: `Error: Unknown action: ${mutation.action}` }] };
      } catch (err: any) {
        const details = err.statusDetails?.[0]?.errors;
        const msg = details ? JSON.stringify(details) : (typeof err.message === 'string' ? err.message : JSON.stringify(err.message ?? err));
        return { content: [{ type: 'text', text: `Error: ${msg || 'Unknown Google Ads API error'}` }] };
      }
    },
  );

  server.tool(
    'list_pending_mutations',
    'List all pending (unconfirmed) mutations with their previews and tokens',
    {},
    async () => {
      const items = listPending();
      if (!items.length) {
        return { content: [{ type: 'text', text: 'No pending operations.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    },
  );
}
