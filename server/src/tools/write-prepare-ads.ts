import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { executeGaql } from '../client.js';
import { createToken } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId } from '../validation.js';
import { formatError } from '../errors.js';
import {
  MAX_KEYWORDS_PER_MUTATION,
  safeWordSchema,
  displayAssetIdListSchema,
  displayLogoAssetIdListSchema,
  cloneEntitySchema,
  keywordSchema,
  negativeKeywordLevelSchema,
  entityStatusSchema,
} from './write-schemas.js';
import {
  validationResult,
  validateCustomer,
  normalizeSafeWord,
  prepareResponse,
  adFilter,
  textValues,
  assetIds,
  buildCloneAdQuery,
  validateResponsiveSearchInput,
  validateResponsiveDisplayInput,
  validateResponsiveDisplayText,
  loadImageAssetInfo,
  validateAssetPlacement,
  loadAdState,
  changeLine,
  textChangeLines,
  removedResourceError,
} from './write-helpers.js';

export function registerAdPrepareTools(server: McpServer, cfg: AdsConfig): void {
  server.tool(
    'prepare_responsive_search_ad',
    'Create a paused responsive search ad.',
    {
      customer_id: z.string(),
      ad_group_id: z.string(),
      headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
      descriptions: z.array(z.string().min(1).max(90)).min(2).max(4),
      final_url: z.string().url(),
      safe_word: safeWordSchema,
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
    'Create a paused responsive display ad.',
    {
      customer_id: z.string(),
      ad_group_id: z.string(),
      business_name: z.string().min(1).max(25),
      headlines: z.array(z.string().min(1).max(30)).min(1).max(5),
      long_headline: z.string().min(1).max(90),
      descriptions: z.array(z.string().min(1).max(90)).min(1).max(5),
      final_url: z.string().url(),
      marketing_image_asset_ids: displayAssetIdListSchema,
      square_marketing_image_asset_ids: displayAssetIdListSchema,
      logo_image_asset_ids: displayLogoAssetIdListSchema,
      safe_word: safeWordSchema,
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
    'prepare_clone_entity',
    'Clone a responsive search or display ad as paused, optionally replacing text, URL or images.',
    {
      customer_id: z.string(),
      entity: cloneEntitySchema,
      source_ad_id: z.string().optional().describe('Or source_ad_group_ad_resource_name'),
      source_ad_group_ad_resource_name: z.string().optional().describe('Preferred, e.g. customers/1/adGroupAds/2~3'),
      target_ad_group_id: z.string().optional().describe('Default: the source ad group'),
      final_url: z.string().url().optional(),
      business_name: z.string().min(1).max(25).optional(),
      headlines: z.array(z.string().min(1)).optional(),
      long_headline: z.string().min(1).max(90).optional(),
      descriptions: z.array(z.string().min(1)).optional(),
      marketing_image_asset_ids: z.array(z.string()).optional(),
      square_marketing_image_asset_ids: z.array(z.string()).optional(),
      logo_image_asset_ids: z.array(z.string()).optional(),
      safe_word: safeWordSchema,
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
    'prepare_keywords',
    'Add keywords to a Search ad group.',
    {
      customer_id: z.string(),
      ad_group_id: z.string(),
      keywords: z.array(keywordSchema).min(1).max(MAX_KEYWORDS_PER_MUTATION),
      safe_word: safeWordSchema,
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
    'prepare_keyword_status',
    'Enable, pause or remove keywords.',
    {
      customer_id: z.string(),
      ad_group_id: z.string(),
      keywords: z.array(z.object({
        criterion_id: z.string(),
        label: z.string().describe('Preview label'),
        new_status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']),
      })).min(1).max(MAX_KEYWORDS_PER_MUTATION),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, ad_group_id, keywords, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const normalizedKeywords = keywords.map(kw => ({
        criterion_id: normalizeResourceId(kw.criterion_id),
        label: kw.label,
        new_status: kw.new_status,
      }));
      const uniqueIds = new Set(normalizedKeywords.map(kw => kw.criterion_id));
      if (uniqueIds.size !== normalizedKeywords.length) {
        return validationResult('Duplicate criterion_id in the request.');
      }
      const preview = [
        `Update ${normalizedKeywords.length} keyword status(es) in ad group ${normalizedAdGroupId}, account ${normalizedCustomerId}`,
        ...normalizedKeywords.map(kw => `- ${kw.new_status}: ${kw.label} (criterion ${kw.criterion_id})`),
      ].join('\n');
      const mutation = createToken('keyword_status', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        keywords: normalizedKeywords,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_ad_update',
    'Update an RSA or RDA\'s status, URL, headlines or descriptions; preview shows before -> after.',
    {
      customer_id: z.string(),
      ad_id: z.string(),
      status: entityStatusSchema.optional(),
      final_url: z.string().url().optional(),
      headlines: z.array(z.string().min(1)).optional().describe('Replaces the list. RSA 3-15, RDA 1-5, max 30 chars'),
      descriptions: z.array(z.string().min(1)).optional().describe('Replaces the list. RSA 2-4, RDA 1-5, max 90 chars'),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, ad_id, status, final_url, headlines, descriptions, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if (status === undefined && final_url === undefined && headlines === undefined && descriptions === undefined) {
        return validationResult('Provide at least one field to update.');
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdId = normalizeResourceId(ad_id);
      const state = await loadAdState(cfg, normalizedCustomerId, normalizedAdId);
      if (!state) return validationResult(`Ad ${normalizedAdId} not found on account ${normalizedCustomerId}.`);
      const removedError = removedResourceError('Ad', String(normalizedAdId), state.status)
        ?? removedResourceError('Ad group', state.adGroupName, state.adGroupStatus)
        ?? removedResourceError('Campaign', state.campaignName, state.campaignStatus);
      if (removedError) return validationResult(removedError);
      const isSearch = state.type === 'RESPONSIVE_SEARCH_AD';
      const isDisplay = state.type === 'RESPONSIVE_DISPLAY_AD';
      const textChanged = headlines !== undefined || descriptions !== undefined;
      if (textChanged && !isSearch && !isDisplay) {
        return validationResult(`Ad ${normalizedAdId} is ${state.type || 'of an unsupported type'}; text updates are supported only for RESPONSIVE_SEARCH_AD and RESPONSIVE_DISPLAY_AD. Use prepare_clone_entity to build a replacement ad instead.`);
      }
      const nextHeadlines = headlines ?? state.headlines;
      const nextDescriptions = descriptions ?? state.descriptions;
      if (textChanged) {
        const textError = isSearch
          ? validateResponsiveSearchInput(nextHeadlines, nextDescriptions)
          : validateResponsiveDisplayText(nextHeadlines, nextDescriptions);
        if (textError) return validationResult(textError);
      }
      const lines = [
        `Update ad ${normalizedAdId} (${state.type}) in ad group "${state.adGroupName}" (${state.adGroupId}), account ${normalizedCustomerId}`,
      ];
      if (status !== undefined) lines.push(changeLine('Status', state.status, status));
      if (final_url !== undefined) lines.push(changeLine('Final URL', state.finalUrls[0], final_url));
      if (headlines !== undefined) lines.push(...textChangeLines('Headlines', state.headlines, nextHeadlines));
      if (descriptions !== undefined) lines.push(...textChangeLines('Descriptions', state.descriptions, nextDescriptions));
      if (textChanged) {
        lines.push('Warning: this replaces the ad text in place, so the previous wording is lost and asset-level performance data restarts for the changed assets. Clone the ad first if you want to keep the current version running.');
      }
      const preview = lines.join('\n');
      const mutation = createToken('ad_update', {
        customer_id: normalizedCustomerId,
        ad_group_id: state.adGroupId,
        ad_id: normalizedAdId,
        status,
        final_url,
        headlines: headlines === undefined ? undefined : nextHeadlines,
        descriptions: descriptions === undefined ? undefined : nextDescriptions,
        creative_kind: isDisplay ? 'responsive_display_ad' : 'responsive_search_ad',
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_ad_status',
    'Enable or pause an ad.',
    {
      customer_id: z.string(),
      ad_group_id: z.string(),
      ad_id: z.string(),
      ad_name: z.string().describe('Preview label'),
      new_status: z.enum(['ENABLED', 'PAUSED']),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, ad_group_id, ad_id, ad_name, new_status, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const normalizedAdId = normalizeResourceId(ad_id);
      const action = new_status === 'ENABLED' ? 'Enable' : 'Pause';
      const preview = `${action} ad "${ad_name}" (ID: ${normalizedAdId}) in ad group ${normalizedAdGroupId}, account ${normalizedCustomerId}`;
      const mutation = createToken('ad_status', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        ad_id: normalizedAdId,
        new_status,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_negative_keywords',
    'Add negative keywords at campaign or ad group level.',
    {
      customer_id: z.string(),
      level: negativeKeywordLevelSchema,
      campaign_id: z.string().optional().describe('Required when level=campaign'),
      ad_group_id: z.string().optional().describe('Required when level=ad_group'),
      keywords: z.array(keywordSchema).min(1).max(MAX_KEYWORDS_PER_MUTATION),
      safe_word: safeWordSchema,
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
}
