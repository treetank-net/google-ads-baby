import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { createToken } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId } from '../validation.js';
import {
  MAX_BUDGET_MICROS,
  MAX_CPC_MICROS,
  MAX_TARGETING_CRITERIA_PER_MUTATION,
  MAX_DEMOGRAPHIC_MODIFIERS_PER_MUTATION,
  MAX_CONVERSION_GOALS_PER_MUTATION,
  MAX_AD_SCHEDULES_PER_MUTATION,
  MAX_AD_GROUP_CRITERIA_PER_MUTATION,
  MAX_NEGATIVE_TOPICS_PER_MUTATION,
  MAX_BID_MODIFIER,
  MAX_KEYWORDS_PER_MUTATION,
  safeWordSchema,
  keywordMatchTypeSchema,
  campaignRefSchema,
  criterionIdListSchema,
  campaignAssetFieldTypeSchema,
  adGroupCriterionResourceNameSchema,
  negativeTopicSchema,
} from './write-schemas.js';
import {
  validationResult,
  validateCustomer,
  normalizeSafeWord,
  prepareResponse,
  loadImageAssetInfo,
  validateAssetPlacement,
} from './write-helpers.js';
import {
  buildSearchCampaignPayload,
  formatSearchCampaignPreview,
  buildDisplayCampaignPayload,
  formatDisplayCampaignPreview,
  buildPerformanceMaxPayload,
  formatPmaxCampaignPreview,
} from './presets.js';

export function registerCampaignPrepareTools(server: McpServer, cfg: AdsConfig): void {
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
    'prepare_search_campaign_full',
    'Prepare a COMPLETE Search campaign in ONE atomic operation: budget + campaign + bidding + geo/language targeting + ad groups (each with keywords and a responsive search ad) + extensions (sitelinks/callouts/call). Optionally driven by a preset that fills sane defaults. Returns a SINGLE preview and ONE confirmation token — the user confirms once for the whole campaign. Prefer this over calling prepare_search_campaign + prepare_ad_group + prepare_keywords + ... separately; it is far faster (one model turn, one atomic API transaction, one confirm).',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      preset: z.enum(['ecommerce-search-pl', 'leadgen-search-pl', 'none']).optional().describe('Preset filling defaults: match types (exact+phrase), bidding, geo PL (2616), language PL (1045). Omit/"none" for manual MANUAL_CPC with no targeting defaults.'),
      campaign_name: z.string().min(1).describe('New campaign name'),
      daily_budget_pln: z.number().positive().describe('Daily budget in PLN; capped by server safety limit'),
      final_url: z.string().url().describe('Default final URL for ads and sitelinks'),
      ad_groups: z.array(z.object({
        name: z.string().min(1).describe('Ad group name'),
        cpc_bid_pln: z.number().positive().optional().describe('CPC bid in PLN; defaults to 1 PLN'),
        final_url: z.string().url().optional().describe('Overrides campaign final_url for this ad group'),
        keywords: z.array(z.object({
          text: z.string().min(1).max(80),
          match_type: keywordMatchTypeSchema.optional().describe('Omit to expand per preset (default exact+phrase)'),
        })).min(1).max(MAX_KEYWORDS_PER_MUTATION).describe('Keywords; without match_type each is expanded to exact+phrase'),
        headlines: z.array(z.string().min(1).max(30)).min(3).max(15).describe('RSA headlines: 3-15, max 30 chars each'),
        descriptions: z.array(z.string().min(1).max(90)).min(2).max(4).describe('RSA descriptions: 2-4, max 90 chars each'),
      })).min(1).max(20).describe('Ad groups; each gets its keywords and one responsive search ad'),
      location_criterion_ids: z.array(z.string().regex(/^\d+$/, 'Geo target constant IDs must be numeric')).optional().describe('Geo target constant IDs; defaults from preset (PL=2616)'),
      language_criterion_ids: z.array(z.string().regex(/^\d+$/, 'Language constant IDs must be numeric')).optional().describe('Language constant IDs; defaults from preset (Polish=1045)'),
      positive_geo_target_type: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('Default PRESENCE (recommended for local intent)'),
      bidding: z.object({
        type: z.enum(['MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']),
        target_cpa_pln: z.number().positive().optional().describe('Required for TARGET_CPA; optional tCPA for MAXIMIZE_CONVERSIONS'),
        target_roas: z.number().positive().max(50).optional().describe('Multiplier, e.g. 4.0 = 400% (NOT a percent). Required for TARGET_ROAS.'),
      }).optional().describe('Overrides preset bidding'),
      campaign_negative_keywords: z.array(z.object({
        text: z.string().min(1).max(80),
        match_type: keywordMatchTypeSchema.optional().describe('Defaults to PHRASE'),
      })).max(MAX_KEYWORDS_PER_MUTATION).optional().describe('Campaign-level negative keywords'),
      sitelinks: z.array(z.object({
        link_text: z.string().min(1).max(25),
        description1: z.string().max(35).optional(),
        description2: z.string().max(35).optional(),
        final_url: z.string().url().optional().describe('Defaults to campaign final_url'),
      })).max(20).optional(),
      callouts: z.array(z.string().min(1).max(25)).max(20).optional(),
      call: z.object({
        country_code: z.string().describe('ISO country code, e.g. PL'),
        phone_number: z.string().describe('Phone number'),
      }).optional(),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async (args) => {
      const customerError = validateCustomer(args.customer_id);
      if (customerError) return customerError;
      const dailyBudgetMicros = Math.round(args.daily_budget_pln * 1_000_000);
      if (dailyBudgetMicros > MAX_BUDGET_MICROS) {
        return validationResult(`Budget ${args.daily_budget_pln} PLN exceeds the safety limit (${MAX_BUDGET_MICROS / 1_000_000} PLN/day).`);
      }
      const normalizedCustomerId = normalizeCustomerId(args.customer_id);

      const payload = buildSearchCampaignPayload({
        preset: args.preset,
        campaignName: args.campaign_name,
        dailyBudgetMicros,
        finalUrl: args.final_url,
        adGroups: args.ad_groups.map((ag) => ({
          name: ag.name,
          cpcBidMicros: ag.cpc_bid_pln ? Math.round(ag.cpc_bid_pln * 1_000_000) : undefined,
          finalUrl: ag.final_url,
          keywords: ag.keywords.map((kw) => ({ text: kw.text, matchType: kw.match_type })),
          headlines: ag.headlines,
          descriptions: ag.descriptions,
        })),
        locationCriterionIds: args.location_criterion_ids,
        languageCriterionIds: args.language_criterion_ids,
        positiveGeoTargetType: args.positive_geo_target_type,
        bidding: args.bidding ? {
          type: args.bidding.type,
          targetCpaMicros: args.bidding.target_cpa_pln ? Math.round(args.bidding.target_cpa_pln * 1_000_000) : undefined,
          targetRoas: args.bidding.target_roas,
        } : undefined,
        campaignNegatives: args.campaign_negative_keywords?.map((n) => ({ text: n.text, matchType: n.match_type })),
        sitelinks: args.sitelinks?.map((s) => ({ linkText: s.link_text, description1: s.description1, description2: s.description2, finalUrl: s.final_url })),
        callouts: args.callouts,
        call: args.call ? { countryCode: args.call.country_code, phoneNumber: args.call.phone_number } : undefined,
      });

      const preview = formatSearchCampaignPreview(normalizedCustomerId, payload);
      const mutation = createToken('search_campaign_full_create', {
        customer_id: normalizedCustomerId,
        payload,
      }, preview, normalizeSafeWord(args.safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_display_campaign_full',
    'Prepare a COMPLETE Display campaign in ONE atomic operation: budget + campaign + bidding + geo/language targeting (defaults PL) + ad group + one responsive display ad (using existing uploaded image asset IDs). Returns a SINGLE preview and ONE confirmation token. Prefer this over separate prepare_display_campaign + prepare_display_ad_group + prepare_responsive_display_ad calls.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      campaign_name: z.string().min(1).describe('New campaign name'),
      daily_budget_pln: z.number().positive().describe('Daily budget in PLN; capped by server safety limit'),
      bidding: z.object({
        type: z.enum(['MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']),
        target_cpa_pln: z.number().positive().optional(),
        target_roas: z.number().positive().max(50).optional().describe('Multiplier, e.g. 4.0 = 400%'),
      }).optional().describe('Defaults to MANUAL_CPC'),
      location_criterion_ids: z.array(z.string().regex(/^\d+$/)).optional().describe('Defaults to PL (2616)'),
      language_criterion_ids: z.array(z.string().regex(/^\d+$/)).optional().describe('Defaults to Polish (1045)'),
      positive_geo_target_type: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional(),
      ad_group: z.object({
        name: z.string().min(1),
        cpc_bid_pln: z.number().positive().optional().describe('Defaults to 1 PLN'),
        optimized_targeting_enabled: z.boolean().optional(),
      }),
      ad: z.object({
        business_name: z.string().min(1).max(25),
        headlines: z.array(z.string().min(1).max(30)).min(1).max(5),
        long_headline: z.string().min(1).max(90),
        descriptions: z.array(z.string().min(1).max(90)).min(1).max(5),
        final_url: z.string().url(),
        marketing_image_asset_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(15).describe('Existing image asset IDs (1.91:1)'),
        square_marketing_image_asset_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(15).describe('Existing square image asset IDs (1:1)'),
        logo_image_asset_ids: z.array(z.string().regex(/^\d+$/)).max(5).describe('Existing logo asset IDs'),
      }),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word; must be shown to the user'),
    },
    async (args) => {
      const customerError = validateCustomer(args.customer_id);
      if (customerError) return customerError;
      const dailyBudgetMicros = Math.round(args.daily_budget_pln * 1_000_000);
      if (dailyBudgetMicros > MAX_BUDGET_MICROS) {
        return validationResult(`Budget ${args.daily_budget_pln} PLN exceeds the safety limit (${MAX_BUDGET_MICROS / 1_000_000} PLN/day).`);
      }
      const normalizedCustomerId = normalizeCustomerId(args.customer_id);

      const payload = buildDisplayCampaignPayload({
        campaignName: args.campaign_name,
        dailyBudgetMicros,
        bidding: args.bidding ? {
          type: args.bidding.type,
          targetCpaMicros: args.bidding.target_cpa_pln ? Math.round(args.bidding.target_cpa_pln * 1_000_000) : undefined,
          targetRoas: args.bidding.target_roas,
        } : undefined,
        locationCriterionIds: args.location_criterion_ids,
        languageCriterionIds: args.language_criterion_ids,
        positiveGeoTargetType: args.positive_geo_target_type,
        adGroup: {
          name: args.ad_group.name,
          cpcBidMicros: args.ad_group.cpc_bid_pln ? Math.round(args.ad_group.cpc_bid_pln * 1_000_000) : undefined,
          optimizedTargetingEnabled: args.ad_group.optimized_targeting_enabled,
        },
        ad: {
          businessName: args.ad.business_name,
          headlines: args.ad.headlines,
          longHeadline: args.ad.long_headline,
          descriptions: args.ad.descriptions,
          finalUrl: args.ad.final_url,
          marketingImageAssetIds: args.ad.marketing_image_asset_ids,
          squareMarketingImageAssetIds: args.ad.square_marketing_image_asset_ids,
          logoImageAssetIds: args.ad.logo_image_asset_ids,
        },
      });

      const preview = formatDisplayCampaignPreview(normalizedCustomerId, payload);
      const mutation = createToken('display_campaign_full_create', {
        customer_id: normalizedCustomerId,
        payload,
      }, preview, normalizeSafeWord(args.safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_performance_max_campaign_full',
    'Prepare a COMPLETE Performance Max campaign in ONE atomic operation: budget + campaign (AI asset enhancements OFF by default) + asset group + inline text assets (headlines/long headlines/descriptions/business name) + linked existing image assets + optional audience signals. Returns a SINGLE preview and ONE confirmation token. Builds an asset-based PMax (no Merchant feed / listing groups).',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      campaign_name: z.string().min(1).describe('New campaign name'),
      daily_budget_pln: z.number().positive().describe('Daily budget in PLN; capped by server safety limit'),
      target_roas: z.number().positive().max(50).optional().describe('Optional tROAS multiplier, e.g. 4.0 = 400% (NOT a percent)'),
      opt_out_ai_enhancements: z.boolean().optional().describe('Default true: opt out of text + final URL expansion automation'),
      asset_group_name: z.string().min(1),
      final_urls: z.array(z.string().url()).min(1),
      business_name: z.string().min(1).max(25).optional(),
      headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
      long_headlines: z.array(z.string().min(1).max(90)).min(1).max(5),
      descriptions: z.array(z.string().min(1).max(90)).min(2).max(5),
      image_assets: z.array(z.object({
        asset_id: z.string().regex(/^\d+$/),
        field_type: z.enum(['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO']),
      })).min(1).describe('Existing image asset IDs with their field type'),
      audience_signals: z.array(z.object({
        type: z.enum(['SEARCH_THEME', 'AUDIENCE']),
        text: z.string().min(1).max(80).optional().describe('Required for SEARCH_THEME'),
        audience_id: z.string().regex(/^\d+$/).optional().describe('Required for AUDIENCE'),
      })).optional(),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word; must be shown to the user'),
    },
    async (args) => {
      const customerError = validateCustomer(args.customer_id);
      if (customerError) return customerError;
      const dailyBudgetMicros = Math.round(args.daily_budget_pln * 1_000_000);
      if (dailyBudgetMicros > MAX_BUDGET_MICROS) {
        return validationResult(`Budget ${args.daily_budget_pln} PLN exceeds the safety limit (${MAX_BUDGET_MICROS / 1_000_000} PLN/day).`);
      }
      const normalizedCustomerId = normalizeCustomerId(args.customer_id);

      const payload = buildPerformanceMaxPayload({
        campaignName: args.campaign_name,
        dailyBudgetMicros,
        targetRoas: args.target_roas,
        optOutAiEnhancements: args.opt_out_ai_enhancements,
        assetGroupName: args.asset_group_name,
        finalUrls: args.final_urls,
        businessName: args.business_name,
        headlines: args.headlines,
        longHeadlines: args.long_headlines,
        descriptions: args.descriptions,
        imageAssets: args.image_assets.map((a) => ({ assetId: a.asset_id, fieldType: a.field_type })),
        audienceSignals: args.audience_signals?.map((s) => s.type === 'SEARCH_THEME'
          ? { type: 'SEARCH_THEME' as const, text: s.text ?? '' }
          : { type: 'AUDIENCE' as const, audienceId: s.audience_id ?? '' }),
      });

      const preview = formatPmaxCampaignPreview(normalizedCustomerId, payload);
      const mutation = createToken('performance_max_campaign_full_create', {
        customer_id: normalizedCustomerId,
        payload,
      }, preview, normalizeSafeWord(args.safe_word));
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
      optimized_targeting_enabled: z.boolean().optional().describe('Optimized targeting flag. Set false to keep delivery strictly within your audience selection. Omit to use the Google default.'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, ad_group_name, cpc_bid_pln, optimized_targeting_enabled, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const cpcMicros = Math.round(cpc_bid_pln * 1_000_000);
      if (cpcMicros > MAX_CPC_MICROS) {
        return validationResult(`CPC bid ${cpc_bid_pln} PLN exceeds the safety limit (${MAX_CPC_MICROS / 1_000_000} PLN).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const optimizedTargetingLine = optimized_targeting_enabled === undefined
        ? '(Google default)'
        : optimized_targeting_enabled ? 'enabled' : 'disabled';
      const preview = [
        `Create paused Display ad group "${ad_group_name}" in campaign ${normalizedCampaignId}, max CPC ${cpc_bid_pln} PLN, account ${normalizedCustomerId}`,
        `Optimized targeting: ${optimizedTargetingLine}`,
      ].join('\n');
      const mutation = createToken('display_ad_group_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        ad_group_name,
        cpc_bid_micros: cpcMicros,
        optimized_targeting_enabled,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_ad_group_settings',
    'Prepare updating settings on an existing ad group. Currently toggles optimized targeting (set false to stop delivery outside your audience selection). Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Existing ad group ID'),
      optimized_targeting_enabled: z.boolean().describe('Optimized targeting flag: true to enable, false to disable'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, ad_group_id, optimized_targeting_enabled, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const preview = [
        `Update ad group ${normalizedAdGroupId} settings, account ${normalizedCustomerId}`,
        `Optimized targeting: ${optimized_targeting_enabled ? 'enabled' : 'disabled'}`,
      ].join('\n');
      const mutation = createToken('ad_group_settings_update', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        optimized_targeting_enabled,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_remove_ad_group_criterion',
    'Prepare removal of ad group criteria (e.g. display topics, placements, audiences) by full resource name. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      resource_names: z.array(adGroupCriterionResourceNameSchema).min(1).max(MAX_AD_GROUP_CRITERIA_PER_MUTATION).describe('Ad group criterion resource names, e.g. customers/123/adGroupCriteria/456~789'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, resource_names, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const uniqueResourceNames = [...new Set(resource_names)];
      if (uniqueResourceNames.length !== resource_names.length) {
        return validationResult('Duplicate resource_names in the request. Remove duplicates before prepare.');
      }
      const preview = [
        `Remove ${uniqueResourceNames.length} ad group criterion(s) on account ${normalizedCustomerId}:`,
        ...uniqueResourceNames.map((name) => `- ${name}`),
      ].join('\n');
      const mutation = createToken('remove_ad_group_criterion', {
        customer_id: normalizedCustomerId,
        resource_names: uniqueResourceNames,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_negative_topics',
    'Prepare creation of negative topic criteria at campaign level (excludes content categories from delivery). Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Campaign ID to exclude topics from'),
      topics: z.array(negativeTopicSchema).min(1).max(MAX_NEGATIVE_TOPICS_PER_MUTATION).describe('Topic constants to exclude, e.g. ["topicConstants/1149"] or ["1149"]'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, topics, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const topicConstants = topics.map((topic) => topic.startsWith('topicConstants/') ? topic : `topicConstants/${topic}`);
      const uniqueTopics = [...new Set(topicConstants)];
      if (uniqueTopics.length !== topicConstants.length) {
        return validationResult('Duplicate topics in the request. Remove duplicates before prepare.');
      }
      const preview = [
        `Create ${uniqueTopics.length} negative topic(s) for campaign ${normalizedCampaignId}, account ${normalizedCustomerId}:`,
        ...uniqueTopics.map((topic) => `- ${topic}`),
      ].join('\n');
      const mutation = createToken('negative_topics_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        topic_constants: uniqueTopics,
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
    'prepare_bidding_strategy',
    'Prepare changing the bidding strategy of a campaign (e.g. from Manual CPC to Target CPA or Target ROAS). Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing campaign ID'),
      strategy_type: z.enum(['TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'MANUAL_CPC', 'ENHANCED_CPC']).describe('Bidding strategy type'),
      target_cpa_pln: z.number().positive().optional().describe('Target CPA in PLN (required for TARGET_CPA)'),
      target_roas: z.number().positive().optional().describe('Target ROAS as a multiplier, e.g. 4.0 means 400% ROAS (required for TARGET_ROAS)'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, campaign_id, strategy_type, target_cpa_pln, target_roas, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if (strategy_type === 'TARGET_CPA' && !target_cpa_pln) {
        return validationResult('target_cpa_pln is required for TARGET_CPA strategy.');
      }
      if (strategy_type === 'TARGET_ROAS' && !target_roas) {
        return validationResult('target_roas is required for TARGET_ROAS strategy.');
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const strategyDetails = strategy_type === 'TARGET_CPA'
        ? `Target CPA: ${target_cpa_pln} PLN`
        : strategy_type === 'TARGET_ROAS'
        ? `Target ROAS: ${target_roas}x`
        : strategy_type;
      const preview = `Change bidding strategy of campaign ${normalizedCampaignId} to ${strategyDetails}, account ${normalizedCustomerId}`;
      const mutation = createToken('bidding_strategy_change', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        strategy_type,
        target_cpa_micros: target_cpa_pln ? Math.round(target_cpa_pln * 1_000_000) : undefined,
        target_roas,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_demographic_bid_modifier',
    'Prepare setting bid modifiers for demographic criteria (age range / gender) on a campaign or ad group. Use execute_gaql first to get criterion IDs. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      level: z.enum(['campaign', 'ad_group']).describe('Level to set bid modifiers on'),
      campaign_id: z.string().optional().describe('Campaign ID, required when level=campaign'),
      ad_group_id: z.string().optional().describe('Ad group ID, required when level=ad_group'),
      modifiers: z.array(z.object({
        criterion_id: z.string().describe('Criterion ID for the demographic (from GAQL: ad_group_criterion.criterion_id or campaign_criterion.criterion_id)'),
        label: z.string().describe('Human-readable label for preview, e.g. "AGE_RANGE_65_UP" or "FEMALE"'),
        bid_modifier: z.number().min(0).max(MAX_BID_MODIFIER).describe('Bid modifier multiplier: 0.0 to exclude, 1.0 = no change, 1.5 = +50%, 0.5 = -50%'),
      })).min(1).max(MAX_DEMOGRAPHIC_MODIFIERS_PER_MUTATION).describe('Demographic bid modifiers to set'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, level, campaign_id, ad_group_id, modifiers, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if (level === 'campaign' && !campaign_id) return validationResult('campaign_id is required when level=campaign.');
      if (level === 'ad_group' && !ad_group_id) return validationResult('ad_group_id is required when level=ad_group.');
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const targetId = level === 'campaign'
        ? normalizeResourceId(campaign_id!)
        : normalizeResourceId(ad_group_id!);
      const normalizedModifiers = modifiers.map(m => ({
        criterion_id: normalizeResourceId(m.criterion_id),
        label: m.label,
        bid_modifier: m.bid_modifier,
      }));
      const uniqueIds = new Set(normalizedModifiers.map(m => m.criterion_id));
      if (uniqueIds.size !== normalizedModifiers.length) {
        return validationResult('Duplicate criterion_id in modifiers.');
      }
      const preview = [
        `Set ${normalizedModifiers.length} demographic bid modifier(s) on ${level} ${targetId}, account ${normalizedCustomerId}`,
        ...normalizedModifiers.map(m => {
          const pct = m.bid_modifier === 0 ? 'EXCLUDE' : `${((m.bid_modifier - 1) * 100).toFixed(0)}%`;
          return `- ${m.label} (criterion ${m.criterion_id}): ${m.bid_modifier}x (${pct})`;
        }),
      ].join('\n');
      const mutation = createToken('demographic_bid_modifier', {
        customer_id: normalizedCustomerId,
        level,
        target_id: targetId,
        modifiers: normalizedModifiers,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_campaign_conversion_goals',
    'Prepare updating which conversion goals are primary (biddable) for a campaign. Use execute_gaql first to list campaign_conversion_goal resources. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Campaign ID (for preview)'),
      goals: z.array(z.object({
        resource_name: z.string().describe('Full campaign_conversion_goal resource name, e.g. customers/123/campaignConversionGoals/456~PURCHASE~WEBSITE'),
        biddable: z.boolean().describe('true = PRIMARY (Smart Bidding optimizes for this), false = SECONDARY (tracked but not optimized)'),
        label: z.string().describe('Human-readable label for preview, e.g. "PURCHASE / WEBSITE"'),
      })).min(1).max(MAX_CONVERSION_GOALS_PER_MUTATION).describe('Conversion goals to update'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, campaign_id, goals, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const uniqueNames = new Set(goals.map(g => g.resource_name));
      if (uniqueNames.size !== goals.length) {
        return validationResult('Duplicate resource_name in goals.');
      }
      const primary = goals.filter(g => g.biddable);
      const secondary = goals.filter(g => !g.biddable);
      const preview = [
        `Update conversion goals for campaign ${normalizedCampaignId}, account ${normalizedCustomerId}`,
        ...(primary.length ? [`PRIMARY (${primary.length}): ${primary.map(g => g.label).join(', ')}`] : []),
        ...(secondary.length ? [`SECONDARY (${secondary.length}): ${secondary.map(g => g.label).join(', ')}`] : []),
      ].join('\n');
      const mutation = createToken('campaign_conversion_goals', {
        customer_id: normalizedCustomerId,
        goals: goals.map(g => ({ resource_name: g.resource_name, biddable: g.biddable })),
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_campaign_shared_set',
    'Prepare linking an existing shared set (e.g. negative keyword list) to a campaign. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Campaign ID to link the shared set to'),
      campaign_name: z.string().describe('Campaign name (for preview)'),
      shared_set_id: z.string().describe('Shared set ID (from execute_gaql on shared_set resource)'),
      shared_set_name: z.string().describe('Shared set name (for preview)'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, campaign_id, campaign_name, shared_set_id, shared_set_name, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const normalizedSharedSetId = normalizeResourceId(shared_set_id);
      const preview = `Link shared set "${shared_set_name}" (ID: ${normalizedSharedSetId}) to campaign "${campaign_name}" (ID: ${normalizedCampaignId}), account ${normalizedCustomerId}`;
      const mutation = createToken('campaign_shared_set_link', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        shared_set_id: normalizedSharedSetId,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_ad_schedule',
    'Prepare creating ad schedule criteria (dayparting) with optional bid modifiers for a campaign. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Campaign ID'),
      schedules: z.array(z.object({
        day_of_week: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']).describe('Day of week'),
        start_hour: z.number().int().min(0).max(23).describe('Start hour (0-23)'),
        start_minute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']).default('ZERO').describe('Start minute'),
        end_hour: z.number().int().min(1).max(24).describe('End hour (1-24, where 24 means midnight)'),
        end_minute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']).default('ZERO').describe('End minute'),
        bid_modifier: z.number().min(0).max(MAX_BID_MODIFIER).default(1.0).describe('Bid modifier: 1.0 = no change, 1.5 = +50%'),
      })).min(1).max(MAX_AD_SCHEDULES_PER_MUTATION).describe('Ad schedule entries'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, campaign_id, schedules, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      for (const s of schedules) {
        if (s.end_hour < s.start_hour || (s.end_hour === s.start_hour && s.end_minute === 'ZERO' && s.start_minute !== 'ZERO')) {
          return validationResult(`Invalid schedule: ${s.day_of_week} ${s.start_hour}:${s.start_minute} - ${s.end_hour}:${s.end_minute}. End must be after start.`);
        }
      }
      const preview = [
        `Create ${schedules.length} ad schedule(s) for campaign ${normalizedCampaignId}, account ${normalizedCustomerId}`,
        ...schedules.map(s => {
          const pct = s.bid_modifier === 1.0 ? 'no change' : `${((s.bid_modifier - 1) * 100).toFixed(0)}%`;
          return `- ${s.day_of_week} ${s.start_hour}:${s.start_minute.replace('ZERO', '00').replace('FIFTEEN', '15').replace('THIRTY', '30').replace('FORTY_FIVE', '45')}-${s.end_hour}:${s.end_minute.replace('ZERO', '00').replace('FIFTEEN', '15').replace('THIRTY', '30').replace('FORTY_FIVE', '45')} (bid: ${s.bid_modifier}x / ${pct})`;
        }),
      ].join('\n');
      const mutation = createToken('ad_schedule_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        schedules: schedules.map(s => ({
          day_of_week: s.day_of_week,
          start_hour: s.start_hour,
          start_minute: s.start_minute,
          end_hour: s.end_hour,
          end_minute: s.end_minute,
          bid_modifier: s.bid_modifier,
        })),
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_campaign_extensions',
    'Prepare batch creation of campaign extensions (sitelinks, callouts, call, structured snippets) AND link them to a campaign in one atomic operation. Can also link existing assets (images, logos). Single confirmation for everything.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing campaign ID'),
      sitelinks: z.array(z.object({
        link_text: z.string().min(1).max(25),
        description1: z.string().max(35).default(''),
        description2: z.string().max(35).default(''),
        final_url: z.string().url(),
      })).max(20).default([]).describe('Sitelinks to create and link'),
      callouts: z.array(z.string().min(1).max(25)).max(20).default([]).describe('Callout texts to create and link'),
      call: z.object({
        country_code: z.string().min(2).max(2),
        phone_number: z.string().min(5).max(25),
      }).optional().describe('Phone extension to create and link'),
      structured_snippet: z.object({
        header: z.string().min(1),
        values: z.array(z.string().min(1).max(25)).min(3).max(10),
      }).optional().describe('Structured snippet to create and link'),
      existing_asset_links: z.array(z.object({
        asset_id: z.string(),
        field_type: campaignAssetFieldTypeSchema,
      })).max(20).default([]).describe('Existing assets to link (e.g. images with AD_IMAGE, logos with LOGO)'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word'),
    },
    async ({ customer_id, campaign_id, sitelinks, callouts, call, structured_snippet, existing_asset_links, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const total = sitelinks.length + callouts.length + (call ? 1 : 0) + (structured_snippet ? 1 : 0) + existing_asset_links.length;
      if (total < 1) return validationResult('Provide at least one extension to create or link.');
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const lines = [`Batch campaign extensions for campaign ${normalizedCampaignId}, account ${normalizedCustomerId}`];
      if (sitelinks.length) lines.push(`Sitelinks (${sitelinks.length}): ${sitelinks.map((s) => s.link_text).join(', ')}`);
      if (callouts.length) lines.push(`Callouts (${callouts.length}): ${callouts.join(', ')}`);
      if (call) lines.push(`Call: +${call.country_code} ${call.phone_number}`);
      if (structured_snippet) lines.push(`Snippet: ${structured_snippet.header} → ${structured_snippet.values.join(', ')}`);
      if (existing_asset_links.length) lines.push(`Link existing (${existing_asset_links.length}): ${existing_asset_links.map((a) => `${a.field_type}:${a.asset_id}`).join(', ')}`);
      const preview = lines.join('\n');
      const mutation = createToken('campaign_extensions_batch', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        sitelinks: sitelinks.map((s) => ({ link_text: s.link_text, description1: s.description1, description2: s.description2, final_url: s.final_url })),
        callouts,
        call: call ? { country_code: call.country_code.toUpperCase(), phone_number: call.phone_number } : undefined,
        structured_snippet: structured_snippet ? { header: structured_snippet.header, values: structured_snippet.values } : undefined,
        existing_asset_links: existing_asset_links.map((a) => ({ asset_id: normalizeResourceId(a.asset_id), field_type: a.field_type })),
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );
}
