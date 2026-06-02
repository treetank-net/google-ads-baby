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
  loadImageAssetInfo,
  validateAssetPlacement,
} from './write-helpers.js';

export function registerAdPrepareTools(server: McpServer, cfg: AdsConfig): void {
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
    'prepare_keyword_status',
    'Prepare status change (enable/pause/remove) for existing keywords in an ad group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Ad group ID containing the keywords'),
      keywords: z.array(z.object({
        criterion_id: z.string().describe('Keyword criterion ID (from execute_gaql or list_ads_entities)'),
        label: z.string().describe('Keyword text for preview, e.g. "BROAD: transport services"'),
        new_status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']).describe('Target status'),
      })).min(1).max(MAX_KEYWORDS_PER_MUTATION).describe('Keywords to update'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
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
    'prepare_ad_status',
    'Prepare status change (enable/pause) for an existing ad. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Ad group ID containing the ad'),
      ad_id: z.string().describe('Ad ID (from execute_gaql or list_ads_entities)'),
      ad_name: z.string().describe('Ad description for preview, e.g. "RSA: Transport | Logistics | ..."'),
      new_status: z.enum(['ENABLED', 'PAUSED']).describe('Target status'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
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
}
