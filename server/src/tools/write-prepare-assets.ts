import { z } from 'zod';
import { readFileSync, statSync } from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { createToken } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId } from '../validation.js';
import {
  MAX_IMAGE_BYTES,
  MAX_CAMPAIGN_ASSETS_PER_MUTATION,
  MAX_ASSET_GROUP_ASSETS_PER_MUTATION,
  MAX_ASSET_GROUP_SIGNALS_PER_MUTATION,
  MAX_ASSET_GROUP_LISTING_GROUP_NODES_PER_MUTATION,
  safeWordSchema,
  assetFieldTypeSchema,
  campaignAssetSchema,
  adGroupAssetSchema,
  assetGroupSignalSchema,
  listingGroupNodeSchema,
} from './write-schemas.js';
import {
  validationResult,
  validateCustomer,
  normalizeSafeWord,
  prepareResponse,
  inspectImageBuffer,
  formatImageInfo,
  fetchImageForPreview,
  loadImageAssetInfo,
  validateAssetPlacement,
  type ImageInfo,
} from './write-helpers.js';

export function registerAssetPrepareTools(server: McpServer, cfg: AdsConfig): void {
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
    'prepare_sitelink_assets',
    'Prepare creation of sitelink assets. After creation, link them to a campaign via prepare_campaign_assets with field_type SITELINK. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      sitelinks: z.array(z.object({
        link_text: z.string().min(1).max(25).describe('Sitelink text shown in the ad, max 25 chars'),
        description1: z.string().max(35).default('').describe('First description line, max 35 chars'),
        description2: z.string().max(35).default('').describe('Second description line, max 35 chars'),
        final_url: z.string().min(1).describe('Landing page URL for this sitelink'),
      })).min(1).max(20).describe('Sitelinks to create'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, sitelinks, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const preview = [
        `Create ${sitelinks.length} sitelink asset(s) on account ${normalizedCustomerId}`,
        ...sitelinks.map((s) => `- "${s.link_text}" → ${s.final_url}`),
      ].join('\n');
      const mutation = createToken('sitelink_assets_create', {
        customer_id: normalizedCustomerId,
        sitelinks: sitelinks.map((s) => ({
          link_text: s.link_text,
          description1: s.description1,
          description2: s.description2,
          final_url: s.final_url,
        })),
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_callout_assets',
    'Prepare creation of callout assets (short USP phrases like "Free shipping", "24/7 support"). After creation, link them to a campaign via prepare_campaign_assets with field_type CALLOUT. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      callouts: z.array(z.string().min(1).max(25)).min(1).max(20).describe('Callout texts, max 25 chars each'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, callouts, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const preview = [
        `Create ${callouts.length} callout asset(s) on account ${normalizedCustomerId}`,
        ...callouts.map((c) => `- "${c}"`),
      ].join('\n');
      const mutation = createToken('callout_assets_create', {
        customer_id: normalizedCustomerId,
        callouts,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_call_asset',
    'Prepare creation of a call (phone) asset for click-to-call extensions. After creation, link it to a campaign via prepare_campaign_assets with field_type CALL. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      country_code: z.string().min(2).max(2).describe('Two-letter country code, e.g. PL, US, DE'),
      phone_number: z.string().min(5).max(25).describe('Phone number in local or international format'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, country_code, phone_number, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const preview = `Create call asset +${country_code} ${phone_number} on account ${normalizedCustomerId}`;
      const mutation = createToken('call_asset_create', {
        customer_id: normalizedCustomerId,
        country_code: country_code.toUpperCase(),
        phone_number,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_structured_snippet_assets',
    'Prepare creation of structured snippet assets (e.g. header "Types" with values "Sedan, SUV, Truck"). After creation, link to a campaign via prepare_campaign_assets with field_type STRUCTURED_SNIPPET. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      header: z.string().min(1).describe('Snippet header — must be a predefined Google Ads header, e.g. "Brands", "Types", "Destinations", "Courses", "Services", "Styles", "Amenities"'),
      values: z.array(z.string().min(1).max(25)).min(3).max(10).describe('Snippet values, 3-10 items, max 25 chars each'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, header, values, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const preview = [
        `Create structured snippet asset on account ${normalizedCustomerId}`,
        `Header: ${header}`,
        `Values: ${values.join(', ')}`,
      ].join('\n');
      const mutation = createToken('structured_snippet_assets_create', {
        customer_id: normalizedCustomerId,
        header,
        values,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_campaign_assets',
    'Prepare linking existing assets (images, sitelinks, callouts, etc.) to a campaign. Use this to add image extensions to Search campaigns. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing campaign ID'),
      assets: z.array(campaignAssetSchema).min(1).max(MAX_CAMPAIGN_ASSETS_PER_MUTATION).describe('Assets to link to the campaign'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, assets, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const normalizedAssets = assets.map((asset) => ({
        asset_id: normalizeResourceId(asset.asset_id),
        field_type: asset.field_type,
      }));
      const unique = new Set(normalizedAssets.map((a) => `${a.asset_id}:${a.field_type}`));
      if (unique.size !== normalizedAssets.length) return validationResult('Duplicate asset links in request.');

      const imageAssets = normalizedAssets.filter((a) => a.field_type === 'AD_IMAGE');
      if (imageAssets.length) {
        const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, imageAssets.map((a) => a.asset_id));
        const placementError = validateAssetPlacement('Image extension', imageAssets.map((a) => a.asset_id), imageInfo, 0.8, 2.1);
        if (placementError) return validationResult(placementError);
      }

      const preview = [
        `Link ${normalizedAssets.length} asset(s) to campaign ${normalizedCampaignId}, account ${normalizedCustomerId}`,
        ...normalizedAssets.map((a) => `- ${a.field_type}: asset ${a.asset_id}`),
      ].join('\n');
      const mutation = createToken('campaign_assets_link', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        assets: normalizedAssets,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_ad_group_assets',
    'Prepare linking existing assets (images, sitelinks, callouts, etc.) to an ad group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Existing ad group ID'),
      assets: z.array(adGroupAssetSchema).min(1).max(MAX_CAMPAIGN_ASSETS_PER_MUTATION).describe('Assets to link to the ad group'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, ad_group_id, assets, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const normalizedAssets = assets.map((asset) => ({
        asset_id: normalizeResourceId(asset.asset_id),
        field_type: asset.field_type,
      }));
      const unique = new Set(normalizedAssets.map((a) => `${a.asset_id}:${a.field_type}`));
      if (unique.size !== normalizedAssets.length) return validationResult('Duplicate asset links in request.');

      const imageAssets = normalizedAssets.filter((a) => a.field_type === 'AD_IMAGE');
      if (imageAssets.length) {
        const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, imageAssets.map((a) => a.asset_id));
        const placementError = validateAssetPlacement('Image extension', imageAssets.map((a) => a.asset_id), imageInfo, 0.8, 2.1);
        if (placementError) return validationResult(placementError);
      }

      const preview = [
        `Link ${normalizedAssets.length} asset(s) to ad group ${normalizedAdGroupId}, account ${normalizedCustomerId}`,
        ...normalizedAssets.map((a) => `- ${a.field_type}: asset ${a.asset_id}`),
      ].join('\n');
      const mutation = createToken('ad_group_assets_link', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        assets: normalizedAssets,
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
}
