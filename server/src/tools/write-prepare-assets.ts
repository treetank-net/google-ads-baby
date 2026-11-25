import { z } from 'zod';
import { enums } from 'google-ads-api';
import { readFileSync, statSync } from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { createToken } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId } from '../validation.js';
import { executeGaql, getAccountCurrency, mutateAssetLinkStatus, updateAsset } from '../client.js';
import { formatError } from '../errors.js';
import {
  loadAssetLinks,
  planLinkStatusChange,
  linkCoverageLines,
  linkEntityRef,
  describeAsset,
  describeLinkTarget,
  sortAssetLinks,
  type AssetLink,
} from './asset-links.js';
import {
  MAX_IMAGE_BYTES,
  MAX_CAMPAIGN_ASSETS_PER_MUTATION,
  MAX_ASSET_GROUP_ASSETS_PER_MUTATION,
  MAX_ASSET_GROUP_SIGNALS_PER_MUTATION,
  MAX_ASSET_GROUP_LISTING_GROUP_NODES_PER_MUTATION,
  MAX_ASSET_LINK_SCOPE_IDS,
  assetLinkStatusSchema,
  assetLinkFieldTypeSchema,
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
  dryRunError,
  formatAmount,
  changeLine,
  enumName,
  type ImageInfo,
} from './write-helpers.js';

export function registerAssetPrepareTools(server: McpServer, cfg: AdsConfig): void {
  server.tool(
    'prepare_image_asset_from_file',
    'Upload an image asset from a local file.',
    {
      customer_id: z.string(),
      asset_name: z.string().min(1).max(255),
      file_path: z.string().min(1),
      safe_word: safeWordSchema,
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
    'Upload an image asset from a public URL.',
    {
      customer_id: z.string(),
      asset_name: z.string().min(1).max(255),
      image_url: z.string().url(),
      safe_word: safeWordSchema,
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
    'Create sitelink assets; link them with prepare_campaign_assets (SITELINK).',
    {
      customer_id: z.string(),
      sitelinks: z.array(z.object({
        link_text: z.string().min(1).max(25),
        description1: z.string().max(35).default(''),
        description2: z.string().max(35).default(''),
        final_url: z.string().url(),
      })).min(1).max(20),
      safe_word: safeWordSchema,
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
    'Create callout assets; link them with prepare_campaign_assets (CALLOUT).',
    {
      customer_id: z.string(),
      callouts: z.array(z.string().min(1).max(25)).min(1).max(20),
      safe_word: safeWordSchema,
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
    'Create a call asset; link it with prepare_campaign_assets (CALL).',
    {
      customer_id: z.string(),
      country_code: z.string().min(2).max(2).describe('ISO, e.g. PL'),
      phone_number: z.string().min(5).max(25),
      safe_word: safeWordSchema,
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
    'Create structured snippet assets; link them with prepare_campaign_assets (STRUCTURED_SNIPPET).',
    {
      customer_id: z.string(),
      header: z.string().min(1).describe('Predefined header, e.g. Brands, Types, Services'),
      values: z.array(z.string().min(1).max(25)).min(3).max(10),
      safe_word: safeWordSchema,
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
    'Link existing assets to a campaign, or at account level with customer: true.',
    {
      customer_id: z.string(),
      campaign_id: z.string().optional(),
      customer: z.boolean().optional().describe('Account level instead of campaign_id'),
      assets: z.array(campaignAssetSchema).min(1).max(MAX_CAMPAIGN_ASSETS_PER_MUTATION),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_id, customer, assets, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const accountLevel = customer === true;
      if (accountLevel === Boolean(campaign_id)) return validationResult('Provide either campaign_id or customer: true.');
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = campaign_id ? normalizeResourceId(campaign_id) : '';
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

      if (accountLevel) {
        const preview = [
          `Link ${normalizedAssets.length} asset(s) at account level, account ${normalizedCustomerId}`,
          ...normalizedAssets.map((a) => `- ${a.field_type}: asset ${a.asset_id}`),
          'Account-level assets serve in every campaign that has no enabled assets of the same type of its own.',
        ].join('\n');
        const mutation = createToken('customer_assets_link', {
          customer_id: normalizedCustomerId,
          assets: normalizedAssets,
        }, preview, normalizeSafeWord(safe_word));
        return prepareResponse(cfg, mutation, preview);
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
    'Link existing assets to an ad group.',
    {
      customer_id: z.string(),
      ad_group_id: z.string(),
      assets: z.array(adGroupAssetSchema).min(1).max(MAX_CAMPAIGN_ASSETS_PER_MUTATION),
      safe_word: safeWordSchema,
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
    'Create a paused Performance Max asset group with its core assets.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      asset_group_name: z.string().min(1),
      final_urls: z.array(z.string().url()).min(1).max(20),
      assets: z.array(z.object({
        asset_id: z.string(),
        field_type: assetFieldTypeSchema.describe('e.g. HEADLINE, MARKETING_IMAGE'),
      })).min(1).max(MAX_ASSET_GROUP_ASSETS_PER_MUTATION).describe('Core creatives are required at creation'),
      safe_word: safeWordSchema,
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
    'Link existing assets to a Performance Max asset group.',
    {
      customer_id: z.string(),
      asset_group_id: z.string(),
      assets: z.array(z.object({
        asset_id: z.string(),
        field_type: assetFieldTypeSchema.describe('e.g. HEADLINE, MARKETING_IMAGE'),
      })).min(1).max(MAX_ASSET_GROUP_ASSETS_PER_MUTATION),
      safe_word: safeWordSchema,
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
    'Add search-theme or audience signals to a Performance Max asset group.',
    {
      customer_id: z.string(),
      asset_group_id: z.string(),
      signals: z.array(assetGroupSignalSchema).min(1).max(MAX_ASSET_GROUP_SIGNALS_PER_MUTATION),
      safe_word: safeWordSchema,
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
    'Create a Performance Max listing group tree.',
    {
      customer_id: z.string(),
      asset_group_id: z.string(),
      nodes: z.array(listingGroupNodeSchema).min(2).max(MAX_ASSET_GROUP_LISTING_GROUP_NODES_PER_MUTATION).describe('Parent-first; node 0 is the root subdivision'),
      safe_word: safeWordSchema,
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
    'prepare_asset_link_status',
    'Pause, enable or unlink an asset at account, campaign or ad group level; no scope = every link.',
    {
      customer_id: z.string(),
      asset_id: z.string(),
      new_status: assetLinkStatusSchema.describe('REMOVED unlinks; the asset stays'),
      field_type: assetLinkFieldTypeSchema.optional().describe('e.g. SITELINK'),
      customer: z.boolean().optional().describe('Account-level link'),
      campaign_ids: z.array(z.string()).max(MAX_ASSET_LINK_SCOPE_IDS).optional(),
      ad_group_ids: z.array(z.string()).max(MAX_ASSET_LINK_SCOPE_IDS).optional(),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, asset_id, new_status, field_type, customer, campaign_ids, ad_group_ids, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAssetId = normalizeResourceId(asset_id);
      const scope = {
        customer: customer === true,
        campaignIds: [...new Set((campaign_ids ?? []).map(normalizeResourceId))],
        adGroupIds: [...new Set((ad_group_ids ?? []).map(normalizeResourceId))],
      };
      try {
        const links = await loadAssetLinks(cfg, normalizedCustomerId, {
          assetIds: [normalizedAssetId],
          fieldTypes: field_type ? [field_type] : undefined,
          includeRemoved: true,
        }, { metrics: true });
        if (!links.length) {
          return validationResult(`Asset ${normalizedAssetId} has no${field_type ? ` ${field_type}` : ''} links on account ${normalizedCustomerId}.`);
        }
        const plan = planLinkStatusChange(links, scope, new_status);
        const linkedAt = sortAssetLinks(links).map((link) => `${linkEntityRef(link)} (${link.status})`).join(', ');
        if (plan.missing.length) {
          return validationResult(`Asset ${normalizedAssetId} is not linked at: ${plan.missing.join(', ')}. It is linked at: ${linkedAt}.`);
        }
        if (plan.blocked.length) {
          return validationResult(plan.blocked.map(({ link, reason }) => `${linkEntityRef(link)}: ${reason}`).join('; '));
        }
        if (!plan.changes.length) {
          return validationResult(`Nothing to change: every selected link is already ${new_status} (${linkedAt}).`);
        }

        const fieldTypes = [...new Set(plan.changes.map((link) => link.fieldType))];
        const campaignIds = [...new Set(plan.changes.map((link) => link.campaignId).filter((id): id is string => Boolean(id)))];
        const [accountSiblings, campaignSiblings, currency] = await Promise.all([
          loadAssetLinks(cfg, normalizedCustomerId, { fieldTypes, status: 'ENABLED', levels: ['CUSTOMER'] }),
          campaignIds.length
            ? loadAssetLinks(cfg, normalizedCustomerId, { fieldTypes, status: 'ENABLED', campaignIds })
            : Promise.resolve([] as AssetLink[]),
          getAccountCurrency(cfg, normalizedCustomerId),
        ]);
        const linkRefs = plan.changes.map((link) => ({ level: link.level, resourceName: link.resourceName }));
        const rejected = await dryRunError(() => mutateAssetLinkStatus(cfg, normalizedCustomerId, linkRefs, new_status, true));
        if (rejected) return validationResult(rejected);

        const verb = new_status === 'REMOVED' ? 'Unlink' : new_status === 'PAUSED' ? 'Pause' : 'Enable';
        const preview = [
          `${verb} ${plan.changes.length} link(s) of ${describeAsset(plan.changes[0])}, account ${normalizedCustomerId}`,
          'The asset itself stays on the account; only the links change.',
          ...sortAssetLinks(plan.changes).map((link) => `- ${describeLinkTarget(link)}: ${link.status} → ${new_status} · last 30d: ${link.clicks ?? 0} clicks, ${formatAmount(link.costMicros ?? 0, currency)}`),
          ...plan.skipped.map(({ link, reason }) => `- skipped ${describeLinkTarget(link)}: ${reason}`),
          `Enabled ${fieldTypes.join('/').toLowerCase()} links after the change:`,
          ...linkCoverageLines(plan.changes, [...accountSiblings, ...campaignSiblings], new_status),
          new_status === 'REMOVED'
            ? 'Unlinking cannot be undone; restoring means linking the asset again, with history starting over. PAUSED is the reversible option.'
            : '',
          'Dry run (validate_only): accepted by Google Ads.',
        ].filter(Boolean).join('\n');
        const mutation = createToken('asset_link_status', {
          customer_id: normalizedCustomerId,
          asset_id: normalizedAssetId,
          new_status,
          links: plan.changes.map((link) => ({ level: link.level, resource_name: link.resourceName, target: linkEntityRef(link) })),
        }, preview, normalizeSafeWord(safe_word));
        return prepareResponse(cfg, mutation, preview);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'prepare_asset_update',
    'Edit a sitelink or callout in place; applies wherever it is linked.',
    {
      customer_id: z.string(),
      asset_id: z.string(),
      final_url: z.string().url().optional(),
      link_text: z.string().min(1).max(25).optional(),
      description1: z.string().max(35).optional().describe('Set both or clear both with ""'),
      description2: z.string().max(35).optional(),
      callout_text: z.string().min(1).max(25).optional(),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, asset_id, final_url, link_text, description1, description2, callout_text, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if ([final_url, link_text, description1, description2, callout_text].every((value) => value === undefined)) {
        return validationResult('Provide at least one field to update.');
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAssetId = normalizeResourceId(asset_id);
      try {
        const rows = await executeGaql(cfg, normalizedCustomerId, `
          SELECT
            asset.id,
            asset.type,
            asset.final_urls,
            asset.sitelink_asset.link_text,
            asset.sitelink_asset.description1,
            asset.sitelink_asset.description2,
            asset.callout_asset.callout_text
          FROM asset
          WHERE asset.id = ${normalizedAssetId}
          LIMIT 1
        `) as any[];
        const asset = rows[0]?.asset;
        if (!asset) return validationResult(`Asset ${normalizedAssetId} not found on account ${normalizedCustomerId}.`);
        const state = assetEditState(asset);
        const patchError = assetPatchError(state.type, { final_url, link_text, description1, description2, callout_text }, state);
        if (patchError) return validationResult(patchError);

        const patch = {
          final_url: final_url !== undefined && final_url !== state.finalUrl ? final_url : undefined,
          link_text: link_text !== undefined && link_text !== state.linkText ? link_text : undefined,
          description1: description1 !== undefined && description1 !== state.description1 ? description1 : undefined,
          description2: description2 !== undefined && description2 !== state.description2 ? description2 : undefined,
          callout_text: callout_text !== undefined && callout_text !== state.calloutText ? callout_text : undefined,
        };
        const changed = Object.entries(patch).filter(([, value]) => value !== undefined);
        if (!changed.length) return validationResult('Nothing to change: every given field already has that value.');

        const links = await loadAssetLinks(cfg, normalizedCustomerId, { assetIds: [normalizedAssetId] });
        const clientPatch = {
          finalUrl: patch.final_url,
          linkText: patch.link_text,
          description1: patch.description1,
          description2: patch.description2,
          calloutText: patch.callout_text,
        };
        const rejected = await dryRunError(() => updateAsset(cfg, normalizedCustomerId, normalizedAssetId, clientPatch, true));
        if (rejected) return validationResult(rejected);

        const before: Record<string, string> = {
          final_url: state.finalUrl,
          link_text: state.linkText,
          description1: state.description1,
          description2: state.description2,
          callout_text: state.calloutText,
        };
        const preview = [
          `Update ${state.type.toLowerCase()} asset ${normalizedAssetId} "${state.linkText || state.calloutText}", account ${normalizedCustomerId}`,
          ...changed.map(([field, value]) => changeLine(field, before[field], value === '' ? '(cleared)' : value)),
          links.length
            ? `Linked in ${links.length} place(s); the edit applies to all of them:`
            : 'Not linked anywhere yet.',
          ...sortAssetLinks(links).map((link) => `- ${describeLinkTarget(link)}, link ${link.status}`),
          `Statistics stay with asset ${normalizedAssetId}, so results before and after the edit mix in reports.`,
          'Dry run (validate_only): accepted by Google Ads.',
        ].join('\n');
        const mutation = createToken('asset_update', {
          customer_id: normalizedCustomerId,
          asset_id: normalizedAssetId,
          patch: Object.fromEntries(changed),
        }, preview, normalizeSafeWord(safe_word));
        return prepareResponse(cfg, mutation, preview);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: formatError(err) }] };
      }
    },
  );
}

export interface AssetEditState {
  type: string;
  finalUrl: string;
  linkText: string;
  description1: string;
  description2: string;
  calloutText: string;
}

export function assetEditState(asset: any): AssetEditState {
  return {
    type: enumName(enums.AssetType as Record<string | number, string | number>, asset?.type),
    finalUrl: String(asset?.final_urls?.[0] ?? ''),
    linkText: String(asset?.sitelink_asset?.link_text ?? ''),
    description1: String(asset?.sitelink_asset?.description1 ?? ''),
    description2: String(asset?.sitelink_asset?.description2 ?? ''),
    calloutText: String(asset?.callout_asset?.callout_text ?? ''),
  };
}

export function assetPatchError(type: string, input: {
  final_url?: string;
  link_text?: string;
  description1?: string;
  description2?: string;
  callout_text?: string;
}, state: AssetEditState): string | null {
  const sitelinkFields = (['link_text', 'description1', 'description2'] as const).filter((field) => input[field] !== undefined);
  if (type !== 'SITELINK' && sitelinkFields.length) return `Asset is ${type}; ${sitelinkFields.join(', ')} apply only to SITELINK assets.`;
  if (type !== 'CALLOUT' && input.callout_text !== undefined) return `Asset is ${type}; callout_text applies only to CALLOUT assets.`;
  if (input.final_url !== undefined && type !== 'SITELINK') return `Asset is ${type}; final_url edits are supported only for SITELINK assets.`;
  if (type !== 'SITELINK' && type !== 'CALLOUT') return `Asset is ${type}; in-place edits are supported for SITELINK and CALLOUT assets. Create a new asset and swap the links instead.`;
  if (type === 'SITELINK') {
    const first = input.description1 ?? state.description1;
    const second = input.description2 ?? state.description2;
    if (Boolean(first) !== Boolean(second)) return 'Sitelink descriptions go in pairs: set both description1 and description2, or clear both.';
  }
  return null;
}
