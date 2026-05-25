import type { AdsConfig } from '../config.js';
import { executeGaql } from '../client.js';
import { createToken, getTokenTtlSeconds } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId, requireCustomerId } from '../validation.js';
import { MAX_IMAGE_BYTES, CODEX_HOOK_INSTALL_COMMAND } from './write-schemas.js';

export function validationResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
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

export function prepareResponse(cfg: AdsConfig, mutation: { token: string; safeWord: string }, preview: string) {
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
