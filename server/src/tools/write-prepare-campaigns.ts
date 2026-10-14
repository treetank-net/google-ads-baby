import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { createToken } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId } from '../validation.js';
import {
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
  campaignAssetFieldTypeSchema,
  adGroupCriterionResourceNameSchema,
  negativeTopicSchema,
  entityStatusSchema,
  biddingStrategyTypeSchema,
  targetRoasSchema,
} from './write-schemas.js';
import {
  validationResult,
  validateCustomer,
  normalizeSafeWord,
  prepareResponse,
  loadImageAssetInfo,
  validateAssetPlacement,
  amountToMicros,
  formatAmount,
  formatUnits,
  loadAmountLimits,
  amountFieldLimitError,
  budgetLimitError,
  cpcLimitError,
  targetCpaLimitError,
  changeLine,
  microsChangeLine,
  manualBiddingRequiredWarning,
  sharedBudgetWarning,
  removedResourceError,
  loadAdGroupState,
  loadBudgetState,
  loadCampaignState,
  statedAmountMismatchWarning,
} from './write-helpers.js';
import {
  buildSearchCampaignPayload,
  formatSearchCampaignPreview,
  buildDisplayCampaignPayload,
  formatDisplayCampaignPreview,
  buildPerformanceMaxPayload,
  formatPmaxCampaignPreview,
} from './presets.js';
import { resolveTargeting } from './targeting.js';

export function registerCampaignPrepareTools(server: McpServer, cfg: AdsConfig): void {
  server.tool(
    'prepare_campaign_status',
    'Enable or pause a campaign.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      campaign_name: z.string(),
      new_status: z.enum(['ENABLED', 'PAUSED']),
      safe_word: safeWordSchema,
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
    'Remove campaigns.',
    {
      customer_id: z.string(),
      campaigns: z.array(campaignRefSchema).min(1).max(20),
      safe_word: safeWordSchema,
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
    'Change a campaign budget; the preview reads the current amount and flags shared budgets.',
    {
      customer_id: z.string(),
      budget_id: z.string().describe('Campaign budget ID'),
      campaign_name: z.string(),
      current_budget_amount: z.number().optional().describe('Optional: the amount you believe is set; a mismatch is warned'),
      new_budget_amount: z.number(),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, budget_id, campaign_name, current_budget_amount, new_budget_amount, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const budgetError = budgetLimitError(new_budget_amount, limits);
      if (budgetError) return validationResult(budgetError);
      const newMicros = amountToMicros(new_budget_amount);
      const normalizedBudgetId = normalizeResourceId(budget_id);
      const state = await loadBudgetState(cfg, normalizedCustomerId, normalizedBudgetId);
      if (!state) return validationResult(`Budget ${normalizedBudgetId} was not found in account ${normalizedCustomerId}.`);
      const statedMicros = current_budget_amount === undefined ? undefined : amountToMicros(current_budget_amount);
      const lines = [
        `Change budget of campaign "${campaign_name}" (account ${normalizedCustomerId})`,
        microsChangeLine('Daily budget', state.amountMicros, newMicros, limits.currency),
      ];
      const mismatch = statedAmountMismatchWarning(statedMicros, state.amountMicros, limits.currency);
      if (mismatch) lines.push(mismatch);
      const budgetWarning = sharedBudgetWarning(state.referenceCount, state.explicitlyShared);
      if (budgetWarning) lines.push(budgetWarning);
      if (state.campaignNames.length > 1) {
        lines.push(`Campaigns on this budget: ${state.campaignNames.join(', ')}`);
      }
      const preview = lines.join('\n');
      const mutation = createToken('budget_change', { customer_id: normalizedCustomerId, budget_id: normalizedBudgetId, amount_micros: newMicros }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_campaign_update',
    'Update campaign name, status, daily budget or bidding; preview shows before -> after.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      name: z.string().min(1).optional(),
      status: entityStatusSchema.optional(),
      daily_budget_amount: z.number().positive().optional().describe('Applies to the linked budget, which may be shared'),
      strategy_type: biddingStrategyTypeSchema.optional(),
      target_cpa_amount: z.number().positive().optional().describe('Required for TARGET_CPA'),
      target_roas: targetRoasSchema.optional().describe('Multiplier, 4.0 = 400%. Required for TARGET_ROAS'),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_id, name, status, daily_budget_amount, strategy_type, target_cpa_amount, target_roas, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      if (name === undefined && status === undefined && daily_budget_amount === undefined && strategy_type === undefined) {
        return validationResult('Provide at least one field to update.');
      }
      if (daily_budget_amount !== undefined) {
        const limitError = budgetLimitError(daily_budget_amount, limits);
        if (limitError) return validationResult(limitError);
      }
      if (target_cpa_amount !== undefined) {
        const limitError = targetCpaLimitError(target_cpa_amount, limits);
        if (limitError) return validationResult(limitError);
      }
      if (strategy_type === 'TARGET_CPA' && target_cpa_amount === undefined) {
        return validationResult('target_cpa_amount is required for TARGET_CPA strategy.');
      }
      if (strategy_type === 'TARGET_ROAS' && target_roas === undefined) {
        return validationResult('target_roas is required for TARGET_ROAS strategy.');
      }
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const state = await loadCampaignState(cfg, normalizedCustomerId, normalizedCampaignId);
      if (!state) return validationResult(`Campaign ${normalizedCampaignId} not found on account ${normalizedCustomerId}.`);
      const removedError = removedResourceError('Campaign', state.name, state.status);
      if (removedError) return validationResult(removedError);
      if (daily_budget_amount !== undefined && !state.budgetId) {
        return validationResult(`Campaign ${normalizedCampaignId} has no readable budget resource; use prepare_budget_change with an explicit budget_id.`);
      }
      const budgetMicros = daily_budget_amount === undefined ? undefined : amountToMicros(daily_budget_amount);
      const targetCpaMicros = target_cpa_amount === undefined ? undefined : amountToMicros(target_cpa_amount);
      const lines = [`Update campaign ${normalizedCampaignId} "${state.name}", account ${normalizedCustomerId}`];
      if (name !== undefined) lines.push(changeLine('Name', state.name, name));
      if (status !== undefined) lines.push(changeLine('Status', state.status, status));
      if (budgetMicros !== undefined) {
        lines.push(microsChangeLine('Daily budget', state.budgetAmountMicros, budgetMicros, limits.currency));
        const budgetWarning = sharedBudgetWarning(state.budgetReferenceCount, state.budgetExplicitlyShared);
        if (budgetWarning) lines.push(budgetWarning);
      }
      if (strategy_type !== undefined) {
        const target = strategy_type === 'TARGET_CPA'
          ? ` (Target CPA: ${formatAmount(targetCpaMicros, limits.currency)})`
          : strategy_type === 'TARGET_ROAS'
          ? ` (Target ROAS: ${target_roas}x)`
          : '';
        lines.push(`${changeLine('Bidding strategy', state.biddingStrategyType, strategy_type)}${target}`);
      }
      const apiCalls = [
        name !== undefined || status !== undefined ? 'campaign' : null,
        budgetMicros !== undefined ? 'budget' : null,
        strategy_type !== undefined ? 'bidding' : null,
      ].filter((call): call is string => call !== null);
      if (apiCalls.length > 1) {
        lines.push(`Note: this runs as ${apiCalls.length} separate Google Ads API calls (${apiCalls.join(', ')}). A failure partway through can leave the update partially applied.`);
      }
      const preview = lines.join('\n');
      const mutation = createToken('campaign_update', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        name,
        status,
        budget_id: budgetMicros === undefined ? undefined : state.budgetId,
        amount_micros: budgetMicros,
        strategy_type,
        target_cpa_micros: targetCpaMicros,
        target_roas,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_search_campaign',
    'Create an empty paused Search campaign. For a whole campaign use prepare_search_campaign_full.',
    {
      customer_id: z.string(),
      campaign_name: z.string().min(1),
      daily_budget_amount: z.number().positive(),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_name, daily_budget_amount, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const budgetError = budgetLimitError(daily_budget_amount, limits);
      if (budgetError) return validationResult(budgetError);
      const budgetMicros = amountToMicros(daily_budget_amount);
      const preview = `Create paused Search campaign "${campaign_name}" with budget ${formatUnits(daily_budget_amount, limits.currency)}/day on account ${normalizedCustomerId}`;
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
    'Create a whole Search campaign in one atomic confirm: budget, bidding, targeting, ad groups with keywords and RSAs, extensions. Preferred for new campaigns.',
    {
      customer_id: z.string(),
      preset: z.enum(['ecommerce-search', 'leadgen-search', 'none']).optional().describe('Fills match types and bidding, never the market. Omit for MANUAL_CPC'),
      campaign_name: z.string().min(1),
      daily_budget_amount: z.number().positive(),
      final_url: z.string().url().describe('Default URL for ads and sitelinks'),
      ad_groups: z.array(z.object({
        name: z.string().min(1),
        cpc_bid_amount: z.number().positive().optional().describe('Default 1.00'),
        final_url: z.string().url().optional().describe('Overrides campaign final_url'),
        keywords: z.array(z.object({
          text: z.string().min(1).max(80),
          match_type: keywordMatchTypeSchema.optional().describe('Omit to expand to exact+phrase'),
        })).min(1).max(MAX_KEYWORDS_PER_MUTATION),
        headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
        descriptions: z.array(z.string().min(1).max(90)).min(2).max(4),
      })).min(1).max(20),
      locations: z.array(z.string().min(1)).min(1).describe('Required, no default: ask the user. ISO country codes or geo target constant IDs'),
      languages: z.array(z.string().min(1)).min(1).describe('Required, no default: ask the user. ISO language codes or language constant IDs'),
      positive_geo_target_type: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('Default PRESENCE'),
      bidding: z.object({
        type: z.enum(['MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']),
        target_cpa_amount: z.number().positive().optional().describe('Required for TARGET_CPA, optional for MAXIMIZE_CONVERSIONS'),
        target_roas: z.number().positive().max(50).optional().describe('Multiplier, 4.0 = 400%. Required for TARGET_ROAS'),
      }).optional(),
      campaign_negative_keywords: z.array(z.object({
        text: z.string().min(1).max(80),
        match_type: keywordMatchTypeSchema.optional().describe('Default PHRASE'),
      })).max(MAX_KEYWORDS_PER_MUTATION).optional(),
      sitelinks: z.array(z.object({
        link_text: z.string().min(1).max(25),
        description1: z.string().max(35).optional(),
        description2: z.string().max(35).optional(),
        final_url: z.string().url().optional().describe('Default: campaign final_url'),
      })).max(20).optional(),
      callouts: z.array(z.string().min(1).max(25)).max(20).optional(),
      call: z.object({
        country_code: z.string().describe('ISO, e.g. PL'),
        phone_number: z.string(),
      }).optional(),
      safe_word: safeWordSchema,
    },
    async (args) => {
      const customerError = validateCustomer(args.customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(args.customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const limitError = amountFieldLimitError(args, limits);
      if (limitError) return validationResult(limitError);
      const targeting = await resolveTargeting(cfg, normalizedCustomerId, args.locations, args.languages);
      if (targeting.error) return validationResult(targeting.error);
      const dailyBudgetMicros = amountToMicros(args.daily_budget_amount);

      const payload = buildSearchCampaignPayload({
        preset: args.preset,
        campaignName: args.campaign_name,
        dailyBudgetMicros,
        finalUrl: args.final_url,
        adGroups: args.ad_groups.map((ag) => ({
          name: ag.name,
          cpcBidMicros: ag.cpc_bid_amount ? Math.round(ag.cpc_bid_amount * 1_000_000) : undefined,
          finalUrl: ag.final_url,
          keywords: ag.keywords.map((kw) => ({ text: kw.text, matchType: kw.match_type })),
          headlines: ag.headlines,
          descriptions: ag.descriptions,
        })),
        locationCriterionIds: targeting.locations.map((entry) => entry.id),
        languageCriterionIds: targeting.languages.map((entry) => entry.id),
        positiveGeoTargetType: args.positive_geo_target_type,
        bidding: args.bidding ? {
          type: args.bidding.type,
          targetCpaMicros: args.bidding.target_cpa_amount ? Math.round(args.bidding.target_cpa_amount * 1_000_000) : undefined,
          targetRoas: args.bidding.target_roas,
        } : undefined,
        campaignNegatives: args.campaign_negative_keywords?.map((n) => ({ text: n.text, matchType: n.match_type })),
        sitelinks: args.sitelinks?.map((s) => ({ linkText: s.link_text, description1: s.description1, description2: s.description2, finalUrl: s.final_url })),
        callouts: args.callouts,
        call: args.call ? { countryCode: args.call.country_code, phoneNumber: args.call.phone_number } : undefined,
      });

      const preview = formatSearchCampaignPreview(normalizedCustomerId, payload, limits.currency, targeting);
      const mutation = createToken('search_campaign_full_create', {
        customer_id: normalizedCustomerId,
        payload,
      }, preview, normalizeSafeWord(args.safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_display_campaign_full',
    'Create a whole Display campaign in one confirm: budget, bidding, targeting, ad group, responsive display ad from existing images.',
    {
      customer_id: z.string(),
      campaign_name: z.string().min(1),
      daily_budget_amount: z.number().positive(),
      bidding: z.object({
        type: z.enum(['MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']),
        target_cpa_amount: z.number().positive().optional(),
        target_roas: z.number().positive().max(50).optional().describe('Multiplier, 4.0 = 400%'),
      }).optional().describe('Default MANUAL_CPC'),
      locations: z.array(z.string().min(1)).min(1).describe('Required, no default: ask the user. ISO country codes or geo target constant IDs'),
      languages: z.array(z.string().min(1)).min(1).describe('Required, no default: ask the user. ISO language codes or language constant IDs'),
      positive_geo_target_type: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional(),
      ad_group: z.object({
        name: z.string().min(1),
        cpc_bid_amount: z.number().positive().optional().describe('Default 1.00'),
        optimized_targeting_enabled: z.boolean().optional(),
      }),
      ad: z.object({
        business_name: z.string().min(1).max(25),
        headlines: z.array(z.string().min(1).max(30)).min(1).max(5),
        long_headline: z.string().min(1).max(90),
        descriptions: z.array(z.string().min(1).max(90)).min(1).max(5),
        final_url: z.string().url(),
        marketing_image_asset_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(15).describe('1.91:1 image asset IDs'),
        square_marketing_image_asset_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(15).describe('1:1 image asset IDs'),
        logo_image_asset_ids: z.array(z.string().regex(/^\d+$/)).max(5).describe('Logo asset IDs'),
      }),
      safe_word: safeWordSchema,
    },
    async (args) => {
      const customerError = validateCustomer(args.customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(args.customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const limitError = amountFieldLimitError(args, limits);
      if (limitError) return validationResult(limitError);
      const targeting = await resolveTargeting(cfg, normalizedCustomerId, args.locations, args.languages);
      if (targeting.error) return validationResult(targeting.error);
      const dailyBudgetMicros = amountToMicros(args.daily_budget_amount);

      const payload = buildDisplayCampaignPayload({
        campaignName: args.campaign_name,
        dailyBudgetMicros,
        bidding: args.bidding ? {
          type: args.bidding.type,
          targetCpaMicros: args.bidding.target_cpa_amount ? Math.round(args.bidding.target_cpa_amount * 1_000_000) : undefined,
          targetRoas: args.bidding.target_roas,
        } : undefined,
        locationCriterionIds: targeting.locations.map((entry) => entry.id),
        languageCriterionIds: targeting.languages.map((entry) => entry.id),
        positiveGeoTargetType: args.positive_geo_target_type,
        adGroup: {
          name: args.ad_group.name,
          cpcBidMicros: args.ad_group.cpc_bid_amount ? Math.round(args.ad_group.cpc_bid_amount * 1_000_000) : undefined,
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

      const preview = formatDisplayCampaignPreview(normalizedCustomerId, payload, limits.currency, targeting);
      const mutation = createToken('display_campaign_full_create', {
        customer_id: normalizedCustomerId,
        payload,
      }, preview, normalizeSafeWord(args.safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_performance_max_campaign_full',
    'Create a whole asset-based Performance Max campaign in one confirm: budget, asset group, text and existing image assets, signals.',
    {
      customer_id: z.string(),
      campaign_name: z.string().min(1),
      daily_budget_amount: z.number().positive(),
      target_roas: z.number().positive().max(50).optional().describe('Optional multiplier, 4.0 = 400%'),
      opt_out_ai_enhancements: z.boolean().optional().describe('Default true: no text or URL expansion'),
      asset_group_name: z.string().min(1),
      final_urls: z.array(z.string().url()).min(1),
      business_name: z.string().min(1).max(25).optional(),
      headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
      long_headlines: z.array(z.string().min(1).max(90)).min(1).max(5),
      descriptions: z.array(z.string().min(1).max(90)).min(2).max(5),
      image_assets: z.array(z.object({
        asset_id: z.string().regex(/^\d+$/),
        field_type: z.enum(['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO']),
      })).min(1),
      audience_signals: z.array(z.object({
        type: z.enum(['SEARCH_THEME', 'AUDIENCE']),
        text: z.string().min(1).max(80).optional().describe('For SEARCH_THEME'),
        audience_id: z.string().regex(/^\d+$/).optional().describe('For AUDIENCE'),
      })).optional(),
      safe_word: safeWordSchema,
    },
    async (args) => {
      const customerError = validateCustomer(args.customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(args.customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const limitError = amountFieldLimitError(args, limits);
      if (limitError) return validationResult(limitError);
      const dailyBudgetMicros = amountToMicros(args.daily_budget_amount);

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

      const preview = formatPmaxCampaignPreview(normalizedCustomerId, payload, limits.currency);
      const mutation = createToken('performance_max_campaign_full_create', {
        customer_id: normalizedCustomerId,
        payload,
      }, preview, normalizeSafeWord(args.safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_display_campaign',
    'Create an empty paused Display campaign.',
    {
      customer_id: z.string(),
      campaign_name: z.string().min(1),
      daily_budget_amount: z.number().positive(),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_name, daily_budget_amount, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const budgetError = budgetLimitError(daily_budget_amount, limits);
      if (budgetError) return validationResult(budgetError);
      const budgetMicros = amountToMicros(daily_budget_amount);
      const preview = `Create paused Display campaign "${campaign_name}" with budget ${formatUnits(daily_budget_amount, limits.currency)}/day on account ${normalizedCustomerId}`;
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
    'Create an empty paused Performance Max campaign.',
    {
      customer_id: z.string(),
      campaign_name: z.string().min(1),
      daily_budget_amount: z.number().positive(),
      business_name_asset_id: z.string().optional().describe('Optional TEXT asset ID (brand guidelines)'),
      logo_asset_id: z.string().optional().describe('Optional square IMAGE asset ID (brand guidelines)'),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_name, daily_budget_amount, business_name_asset_id, logo_asset_id, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const budgetError = budgetLimitError(daily_budget_amount, limits);
      if (budgetError) return validationResult(budgetError);
      const budgetMicros = amountToMicros(daily_budget_amount);
      const normalizedBusinessNameAssetId = business_name_asset_id ? normalizeResourceId(business_name_asset_id) : undefined;
      const normalizedLogoAssetId = logo_asset_id ? normalizeResourceId(logo_asset_id) : undefined;
      if (normalizedLogoAssetId) {
        const imageInfo = await loadImageAssetInfo(cfg, normalizedCustomerId, [normalizedLogoAssetId]);
        const placementError = validateAssetPlacement('PMax brand logo', [normalizedLogoAssetId], imageInfo, 0.95, 1.05);
        if (placementError) return validationResult(placementError);
      }
      const preview = [
        `Create paused Performance Max campaign "${campaign_name}" with budget ${formatUnits(daily_budget_amount, limits.currency)}/day on account ${normalizedCustomerId}`,
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
    'Create a paused Search ad group.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      ad_group_name: z.string().min(1),
      cpc_bid_amount: z.number().positive(),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_id, ad_group_name, cpc_bid_amount, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const cpcError = cpcLimitError(cpc_bid_amount, limits);
      if (cpcError) return validationResult(cpcError);
      const cpcMicros = amountToMicros(cpc_bid_amount);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const preview = `Create paused ad group "${ad_group_name}" in campaign ${normalizedCampaignId}, max CPC ${formatUnits(cpc_bid_amount, limits.currency)}, account ${normalizedCustomerId}`;
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
    'Create a paused Display ad group.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      ad_group_name: z.string().min(1),
      cpc_bid_amount: z.number().positive(),
      optimized_targeting_enabled: z.boolean().optional().describe('false keeps delivery within your audiences; omit for the Google default'),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_id, ad_group_name, cpc_bid_amount, optimized_targeting_enabled, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      const cpcError = cpcLimitError(cpc_bid_amount, limits);
      if (cpcError) return validationResult(cpcError);
      const cpcMicros = amountToMicros(cpc_bid_amount);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const optimizedTargetingLine = optimized_targeting_enabled === undefined
        ? '(Google default)'
        : optimized_targeting_enabled ? 'enabled' : 'disabled';
      const preview = [
        `Create paused Display ad group "${ad_group_name}" in campaign ${normalizedCampaignId}, max CPC ${formatUnits(cpc_bid_amount, limits.currency)}, account ${normalizedCustomerId}`,
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
    'prepare_ad_group_update',
    'Update ad group CPC, status, name or optimized targeting; preview shows before -> after.',
    {
      customer_id: z.string(),
      ad_group_id: z.string(),
      cpc_bid_amount: z.number().positive().optional().describe('Only matters with MANUAL_CPC'),
      status: entityStatusSchema.optional(),
      name: z.string().min(1).optional(),
      optimized_targeting_enabled: z.boolean().optional().describe('false keeps delivery within your audiences'),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, ad_group_id, cpc_bid_amount, status, name, optimized_targeting_enabled, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      if (cpc_bid_amount === undefined && status === undefined && name === undefined && optimized_targeting_enabled === undefined) {
        return validationResult('Provide at least one field to update.');
      }
      if (cpc_bid_amount !== undefined) {
        const limitError = cpcLimitError(cpc_bid_amount, limits);
        if (limitError) return validationResult(limitError);
      }
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const state = await loadAdGroupState(cfg, normalizedCustomerId, normalizedAdGroupId);
      if (!state) return validationResult(`Ad group ${normalizedAdGroupId} not found on account ${normalizedCustomerId}.`);
      const removedError = removedResourceError('Ad group', state.name, state.status)
        ?? removedResourceError('Campaign', state.campaignName, state.campaignStatus);
      if (removedError) return validationResult(removedError);
      const cpcMicros = cpc_bid_amount === undefined ? undefined : amountToMicros(cpc_bid_amount);
      const lines = [
        `Update ad group ${normalizedAdGroupId} "${state.name}" in campaign "${state.campaignName}" (${state.campaignId}), account ${normalizedCustomerId}`,
      ];
      if (cpcMicros !== undefined) lines.push(microsChangeLine('Max CPC', state.cpcBidMicros, cpcMicros, limits.currency));
      if (status !== undefined) lines.push(changeLine('Status', state.status, status));
      if (name !== undefined) lines.push(changeLine('Name', state.name, name));
      if (optimized_targeting_enabled !== undefined) lines.push(`Optimized targeting: ${optimized_targeting_enabled ? 'enabled' : 'disabled'}`);
      const biddingWarning = cpcMicros === undefined ? null : manualBiddingRequiredWarning(state.biddingStrategyType);
      if (biddingWarning) lines.push(biddingWarning);
      const preview = lines.join('\n');
      const mutation = createToken('ad_group_update', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        cpc_bid_micros: cpcMicros,
        status,
        name,
        optimized_targeting_enabled,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_remove_ad_group_criterion',
    'Remove ad group criteria (topics, placements, audiences).',
    {
      customer_id: z.string(),
      resource_names: z.array(adGroupCriterionResourceNameSchema).min(1).max(MAX_AD_GROUP_CRITERIA_PER_MUTATION).describe('e.g. customers/1/adGroupCriteria/2~3'),
      safe_word: safeWordSchema,
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
    'Exclude topics at campaign level.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      topics: z.array(negativeTopicSchema).min(1).max(MAX_NEGATIVE_TOPICS_PER_MUTATION).describe('Topic constant IDs, e.g. ["1149"]'),
      safe_word: safeWordSchema,
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
    'Add location and language targeting to a campaign.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      locations: z.array(z.string().min(1)).default([]).describe('ISO country codes or geo target constant IDs'),
      languages: z.array(z.string().min(1)).default([]).describe('ISO language codes or language constant IDs'),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_id, locations, languages, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      if (locations.length + languages.length < 1) {
        return validationResult('Provide at least one location or language.');
      }
      if (locations.length + languages.length > MAX_TARGETING_CRITERIA_PER_MUTATION) {
        return validationResult(`Too many targeting criteria. Max ${MAX_TARGETING_CRITERIA_PER_MUTATION}.`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const targeting = await resolveTargeting(cfg, normalizedCustomerId, locations, languages);
      if (targeting.error) return validationResult(targeting.error);
      const uniqueLocations = targeting.locations.map((entry) => entry.id);
      const uniqueLanguages = targeting.languages.map((entry) => entry.id);
      const preview = [
        `Add campaign targeting to campaign ${normalizedCampaignId}, account ${normalizedCustomerId}`,
        `Locations: ${targeting.locations.length ? targeting.locations.map((entry) => entry.label).join(', ') : '(none)'}`,
        `Languages: ${targeting.languages.length ? targeting.languages.map((entry) => entry.label).join(', ') : '(none)'}`,
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
    'Change a campaign\'s bidding strategy.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      strategy_type: biddingStrategyTypeSchema,
      target_cpa_amount: z.number().positive().optional().describe('Required for TARGET_CPA'),
      target_roas: targetRoasSchema.optional().describe('Multiplier, 4.0 = 400%. Required for TARGET_ROAS'),
      safe_word: safeWordSchema,
    },
    async ({ customer_id, campaign_id, strategy_type, target_cpa_amount, target_roas, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const limits = await loadAmountLimits(cfg, normalizedCustomerId);
      if (strategy_type === 'TARGET_CPA' && !target_cpa_amount) {
        return validationResult('target_cpa_amount is required for TARGET_CPA strategy.');
      }
      if (strategy_type === 'TARGET_ROAS' && !target_roas) {
        return validationResult('target_roas is required for TARGET_ROAS strategy.');
      }
      if (target_cpa_amount !== undefined) {
        const limitError = targetCpaLimitError(target_cpa_amount, limits);
        if (limitError) return validationResult(limitError);
      }
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const strategyDetails = strategy_type === 'TARGET_CPA'
        ? `Target CPA: ${formatUnits(target_cpa_amount ?? 0, limits.currency)}`
        : strategy_type === 'TARGET_ROAS'
        ? `Target ROAS: ${target_roas}x`
        : strategy_type;
      const preview = `Change bidding strategy of campaign ${normalizedCampaignId} to ${strategyDetails}, account ${normalizedCustomerId}`;
      const mutation = createToken('bidding_strategy_change', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        strategy_type,
        target_cpa_micros: target_cpa_amount ? amountToMicros(target_cpa_amount) : undefined,
        target_roas,
      }, preview, normalizeSafeWord(safe_word));
      return prepareResponse(cfg, mutation, preview);
    },
  );

  server.tool(
    'prepare_demographic_bid_modifier',
    'Set age/gender bid modifiers on a campaign or ad group.',
    {
      customer_id: z.string(),
      level: z.enum(['campaign', 'ad_group']),
      campaign_id: z.string().optional().describe('Required when level=campaign'),
      ad_group_id: z.string().optional().describe('Required when level=ad_group'),
      modifiers: z.array(z.object({
        criterion_id: z.string().describe('From GAQL *_criterion.criterion_id'),
        label: z.string().describe('Preview label'),
        bid_modifier: z.number().min(0).max(MAX_BID_MODIFIER).describe('0 excludes, 1.0 no change, 1.5 = +50%'),
      })).min(1).max(MAX_DEMOGRAPHIC_MODIFIERS_PER_MUTATION),
      safe_word: safeWordSchema,
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
    'Choose which conversion goals are primary (biddable) for a campaign.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      goals: z.array(z.object({
        resource_name: z.string().describe('campaign_conversion_goal resource name'),
        biddable: z.boolean().describe('true = primary, false = secondary'),
        label: z.string().describe('Preview label'),
      })).min(1).max(MAX_CONVERSION_GOALS_PER_MUTATION),
      safe_word: safeWordSchema,
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
    'Link a shared set, e.g. a negative keyword list, to a campaign.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      campaign_name: z.string(),
      shared_set_id: z.string().describe('From GAQL shared_set'),
      shared_set_name: z.string().describe('Preview label'),
      safe_word: safeWordSchema,
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
    'Add ad schedules (dayparting) with optional bid modifiers.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      schedules: z.array(z.object({
        day_of_week: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']),
        start_hour: z.number().int().min(0).max(23).describe('0-23'),
        start_minute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']).default('ZERO'),
        end_hour: z.number().int().min(1).max(24).describe('1-24, 24 = midnight'),
        end_minute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']).default('ZERO'),
        bid_modifier: z.number().min(0).max(MAX_BID_MODIFIER).default(1.0).describe('1.0 no change, 1.5 = +50%'),
      })).min(1).max(MAX_AD_SCHEDULES_PER_MUTATION),
      safe_word: safeWordSchema,
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
    'Create sitelinks, callouts, call and snippets and link them, plus existing assets, in one confirm.',
    {
      customer_id: z.string(),
      campaign_id: z.string(),
      sitelinks: z.array(z.object({
        link_text: z.string().min(1).max(25),
        description1: z.string().max(35).default(''),
        description2: z.string().max(35).default(''),
        final_url: z.string().url(),
      })).max(20).default([]),
      callouts: z.array(z.string().min(1).max(25)).max(20).default([]),
      call: z.object({
        country_code: z.string().min(2).max(2),
        phone_number: z.string().min(5).max(25),
      }).optional(),
      structured_snippet: z.object({
        header: z.string().min(1),
        values: z.array(z.string().min(1).max(25)).min(3).max(10),
      }).optional(),
      existing_asset_links: z.array(z.object({
        asset_id: z.string(),
        field_type: campaignAssetFieldTypeSchema,
      })).max(20).default([]).describe('e.g. images as AD_IMAGE, logos as LOGO'),
      safe_word: safeWordSchema,
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
