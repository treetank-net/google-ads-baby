import { enums, ResourceNames } from 'google-ads-api';
import { getCustomer } from './core.js';
import type { AdsConfig } from '../config.js';

export async function mutateCampaignStatus(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  status: 'ENABLED' | 'PAUSED',
): Promise<unknown> {
  return mutateCampaignStatuses(cfg, customerId, [{ campaignId, status }]);
}

export async function mutateCampaignStatuses(
  cfg: AdsConfig,
  customerId: string,
  campaigns: Array<{ campaignId: string; status: 'ENABLED' | 'PAUSED' }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.campaigns.update(campaigns.map(({ campaignId, status }) => ({
    resource_name: `customers/${customerId}/campaigns/${campaignId}`,
    status: enums.CampaignStatus[status],
  })));
}

export async function removeCampaigns(
  cfg: AdsConfig,
  customerId: string,
  campaignIds: string[],
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.campaigns.remove(campaignIds.map((campaignId) => (
    `customers/${customerId}/campaigns/${campaignId}`
  )));
}

export async function mutateCampaignBudget(
  cfg: AdsConfig,
  customerId: string,
  budgetId: string,
  amountMicros: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.campaignBudgets.update([
    {
      resource_name: `customers/${customerId}/campaignBudgets/${budgetId}`,
      amount_micros: amountMicros,
    },
  ]);
}

export async function createSearchCampaign(
  cfg: AdsConfig,
  customerId: string,
  name: string,
  dailyBudgetMicros: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const budgetResourceName = ResourceNames.campaignBudget(customerId, '-1');
  return customer.mutateResources([
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: {
        resource_name: budgetResourceName,
        name: `${name} Budget`,
        delivery_method: enums.BudgetDeliveryMethod.STANDARD,
        explicitly_shared: false,
        amount_micros: dailyBudgetMicros,
      },
    },
    {
      entity: 'campaign',
      operation: 'create',
      resource: {
        name,
        advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
        status: enums.CampaignStatus.PAUSED,
        manual_cpc: { enhanced_cpc_enabled: false },
        campaign_budget: budgetResourceName,
        contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        network_settings: {
          target_google_search: true,
          target_search_network: true,
          target_content_network: false,
          target_partner_search_network: false,
        },
      },
    },
  ] as any);
}

export async function createDisplayCampaign(
  cfg: AdsConfig,
  customerId: string,
  name: string,
  dailyBudgetMicros: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const budgetResourceName = ResourceNames.campaignBudget(customerId, '-1');
  return customer.mutateResources([
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: {
        resource_name: budgetResourceName,
        name: `${name} Budget`,
        delivery_method: enums.BudgetDeliveryMethod.STANDARD,
        explicitly_shared: false,
        amount_micros: dailyBudgetMicros,
      },
    },
    {
      entity: 'campaign',
      operation: 'create',
      resource: {
        name,
        advertising_channel_type: enums.AdvertisingChannelType.DISPLAY,
        status: enums.CampaignStatus.PAUSED,
        manual_cpc: { enhanced_cpc_enabled: false },
        campaign_budget: budgetResourceName,
        contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
      },
    },
  ] as any);
}

export async function createPerformanceMaxCampaign(
  cfg: AdsConfig,
  customerId: string,
  name: string,
  dailyBudgetMicros: number,
  brandAssets?: { businessNameAssetId?: string; logoAssetId?: string },
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const budgetResourceName = ResourceNames.campaignBudget(customerId, '-1');
  const campaignResourceName = ResourceNames.campaign(customerId, '-2');
  return customer.mutateResources([
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: {
        resource_name: budgetResourceName,
        name: `${name} Budget`,
        delivery_method: enums.BudgetDeliveryMethod.STANDARD,
        explicitly_shared: false,
        amount_micros: dailyBudgetMicros,
      },
    },
    {
      entity: 'campaign',
      operation: 'create',
      resource: {
        resource_name: campaignResourceName,
        name,
        advertising_channel_type: enums.AdvertisingChannelType.PERFORMANCE_MAX,
        status: enums.CampaignStatus.PAUSED,
        campaign_budget: budgetResourceName,
        maximize_conversion_value: {},
        contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
      },
    },
    ...(brandAssets?.businessNameAssetId ? [{
      entity: 'campaign_asset',
      operation: 'create',
      resource: {
        campaign: campaignResourceName,
        asset: ResourceNames.asset(customerId, brandAssets.businessNameAssetId),
        field_type: enums.AssetFieldType.BUSINESS_NAME,
      },
    }] : []),
    ...(brandAssets?.logoAssetId ? [{
      entity: 'campaign_asset',
      operation: 'create',
      resource: {
        campaign: campaignResourceName,
        asset: ResourceNames.asset(customerId, brandAssets.logoAssetId),
        field_type: enums.AssetFieldType.LOGO,
      },
    }] : []),
  ] as any);
}

export async function createAdGroup(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  name: string,
  cpcBidMicros: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.adGroups.create([
    {
      name,
      campaign: ResourceNames.campaign(customerId, campaignId),
      status: enums.AdGroupStatus.PAUSED,
      type: enums.AdGroupType.SEARCH_STANDARD,
      cpc_bid_micros: cpcBidMicros,
    } as any,
  ]);
}

export async function createDisplayAdGroup(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  name: string,
  cpcBidMicros: number,
  options?: { optimizedTargetingEnabled?: boolean },
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const resource: Record<string, any> = {
    name,
    campaign: ResourceNames.campaign(customerId, campaignId),
    status: enums.AdGroupStatus.PAUSED,
    type: enums.AdGroupType.DISPLAY_STANDARD,
    cpc_bid_micros: cpcBidMicros,
  };
  if (options?.optimizedTargetingEnabled !== undefined) {
    resource.optimized_targeting_enabled = options.optimizedTargetingEnabled;
  }
  return customer.adGroups.create([resource as any]);
}

export async function updateAdGroupSettings(
  cfg: AdsConfig,
  customerId: string,
  adGroupId: string,
  settings: { optimizedTargetingEnabled: boolean },
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.adGroups.update([{
    resource_name: ResourceNames.adGroup(customerId, adGroupId),
    optimized_targeting_enabled: settings.optimizedTargetingEnabled,
  }]);
}

export async function removeAdGroupCriteria(
  cfg: AdsConfig,
  customerId: string,
  resourceNames: string[],
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.adGroupCriteria.remove(resourceNames);
}

export async function createNegativeTopics(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  topicConstants: string[],
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.campaignCriteria.create(topicConstants.map((topicConstant) => ({
    campaign: ResourceNames.campaign(customerId, campaignId),
    negative: true,
    topic: {
      topic_constant: topicConstant,
    },
  }) as any));
}

export async function createCampaignTargeting(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  targeting: {
    locationCriterionIds: string[];
    languageCriterionIds: string[];
  },
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.campaignCriteria.create([
    ...targeting.locationCriterionIds.map((criterionId) => ({
      campaign: ResourceNames.campaign(customerId, campaignId),
      location: {
        geo_target_constant: ResourceNames.geoTargetConstant(criterionId),
      },
    }) as any),
    ...targeting.languageCriterionIds.map((criterionId) => ({
      campaign: ResourceNames.campaign(customerId, campaignId),
      language: {
        language_constant: ResourceNames.languageConstant(criterionId),
      },
    }) as any),
  ]);
}

export async function updateDemographicBidModifiers(
  cfg: AdsConfig,
  customerId: string,
  level: 'campaign' | 'ad_group',
  targetId: string,
  modifiers: Array<{ criterionId: string; bidModifier: number }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const prefix = level === 'campaign' ? 'campaignCriteria' : 'adGroupCriteria';
  const entity = level === 'campaign' ? 'campaign_criterion' : 'ad_group_criterion';
  return customer.mutateResources(modifiers.map(m => ({
    entity,
    operation: 'update',
    resource: {
      resource_name: `customers/${customerId}/${prefix}/${targetId}~${m.criterionId}`,
      bid_modifier: m.bidModifier,
    },
  })) as any);
}

export async function updateCampaignConversionGoals(
  cfg: AdsConfig,
  customerId: string,
  goals: Array<{ resourceName: string; biddable: boolean }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.mutateResources(goals.map(g => ({
    entity: 'campaign_conversion_goal',
    operation: 'update',
    resource: {
      resource_name: g.resourceName,
      biddable: g.biddable,
    },
  })) as any);
}

export async function linkCampaignSharedSet(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  sharedSetId: string,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.mutateResources([{
    entity: 'campaign_shared_set',
    operation: 'create',
    resource: {
      campaign: ResourceNames.campaign(customerId, campaignId),
      shared_set: `customers/${customerId}/sharedSets/${sharedSetId}`,
    },
  }] as any);
}

export async function createAdSchedules(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  schedules: Array<{
    dayOfWeek: string;
    startHour: number;
    startMinute: string;
    endHour: number;
    endMinute: string;
    bidModifier: number;
  }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.campaignCriteria.create(schedules.map(s => ({
    campaign: ResourceNames.campaign(customerId, campaignId),
    ad_schedule: {
      day_of_week: (enums.DayOfWeek as any)[s.dayOfWeek],
      start_hour: s.startHour,
      start_minute: (enums.MinuteOfHour as any)[s.startMinute],
      end_hour: s.endHour,
      end_minute: (enums.MinuteOfHour as any)[s.endMinute],
    },
    bid_modifier: s.bidModifier,
  }) as any));
}

export async function mutateBiddingStrategy(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  strategy: { type: string; targetCpaMicros?: number; targetRoas?: number },
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const resource: Record<string, any> = {
    resource_name: `customers/${customerId}/campaigns/${campaignId}`,
  };
  if (strategy.type === 'TARGET_CPA') {
    resource.target_cpa = { target_cpa_micros: strategy.targetCpaMicros };
  } else if (strategy.type === 'TARGET_ROAS') {
    resource.target_roas = { target_roas: strategy.targetRoas };
  } else if (strategy.type === 'MAXIMIZE_CONVERSIONS') {
    resource.maximize_conversions = {};
  } else if (strategy.type === 'MAXIMIZE_CONVERSION_VALUE') {
    resource.maximize_conversion_value = {};
  } else if (strategy.type === 'MANUAL_CPC') {
    resource.manual_cpc = { enhanced_cpc_enabled: false };
  } else if (strategy.type === 'ENHANCED_CPC') {
    resource.manual_cpc = { enhanced_cpc_enabled: true };
  }
  return customer.campaigns.update([resource]);
}

export interface SearchCampaignBidding {
  type: 'MANUAL_CPC' | 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_CPA' | 'TARGET_ROAS';
  targetCpaMicros?: number;
  targetRoas?: number;
}

export interface SearchCampaignFullPayload {
  campaignName: string;
  dailyBudgetMicros: number;
  status: 'PAUSED' | 'ENABLED';
  bidding: SearchCampaignBidding;
  locationCriterionIds: string[];
  languageCriterionIds: string[];
  positiveGeoTargetType: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
  campaignNegatives: Array<{ text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }>;
  adGroups: Array<{
    name: string;
    cpcBidMicros: number;
    keywords: Array<{ text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }>;
    headlines: string[];
    descriptions: string[];
    finalUrl: string;
  }>;
  sitelinks: Array<{ linkText: string; description1: string; description2: string; finalUrl: string }>;
  callouts: string[];
  call?: { countryCode: string; phoneNumber: string };
}

function searchCampaignBiddingResource(bidding: SearchCampaignBidding): Record<string, any> {
  switch (bidding.type) {
    case 'MAXIMIZE_CONVERSION_VALUE':
      return { maximize_conversion_value: bidding.targetRoas ? { target_roas: bidding.targetRoas } : {} };
    case 'MAXIMIZE_CONVERSIONS':
      return { maximize_conversions: bidding.targetCpaMicros ? { target_cpa_micros: bidding.targetCpaMicros } : {} };
    case 'TARGET_CPA':
      return { target_cpa: { target_cpa_micros: bidding.targetCpaMicros } };
    case 'TARGET_ROAS':
      return { target_roas: { target_roas: bidding.targetRoas } };
    case 'MANUAL_CPC':
    default:
      return { manual_cpc: { enhanced_cpc_enabled: false } };
  }
}

export async function createSearchCampaignFull(
  cfg: AdsConfig,
  customerId: string,
  payload: SearchCampaignFullPayload,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  let temp = 0;
  const nextTemp = () => String(--temp);
  const ops: any[] = [];

  const budgetRn = ResourceNames.campaignBudget(customerId, nextTemp());
  ops.push({
    entity: 'campaign_budget',
    operation: 'create',
    resource: {
      resource_name: budgetRn,
      name: `${payload.campaignName} Budget`,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
      amount_micros: payload.dailyBudgetMicros,
    },
  });

  const campaignRn = ResourceNames.campaign(customerId, nextTemp());
  ops.push({
    entity: 'campaign',
    operation: 'create',
    resource: {
      resource_name: campaignRn,
      name: payload.campaignName,
      advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
      status: enums.CampaignStatus[payload.status],
      campaign_budget: budgetRn,
      ...searchCampaignBiddingResource(payload.bidding),
      network_settings: {
        target_google_search: true,
        target_search_network: true,
        target_content_network: false,
        target_partner_search_network: false,
      },
      geo_target_type_setting: {
        positive_geo_target_type: (enums.PositiveGeoTargetType as any)[payload.positiveGeoTargetType],
      },
      contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    },
  });

  for (const id of payload.locationCriterionIds) {
    ops.push({
      entity: 'campaign_criterion',
      operation: 'create',
      resource: { campaign: campaignRn, location: { geo_target_constant: ResourceNames.geoTargetConstant(id) } },
    });
  }
  for (const id of payload.languageCriterionIds) {
    ops.push({
      entity: 'campaign_criterion',
      operation: 'create',
      resource: { campaign: campaignRn, language: { language_constant: ResourceNames.languageConstant(id) } },
    });
  }
  for (const neg of payload.campaignNegatives) {
    ops.push({
      entity: 'campaign_criterion',
      operation: 'create',
      resource: { campaign: campaignRn, negative: true, keyword: { text: neg.text, match_type: enums.KeywordMatchType[neg.matchType] } },
    });
  }

  for (const ag of payload.adGroups) {
    const adGroupRn = ResourceNames.adGroup(customerId, nextTemp());
    ops.push({
      entity: 'ad_group',
      operation: 'create',
      resource: {
        resource_name: adGroupRn,
        name: ag.name,
        campaign: campaignRn,
        status: enums.AdGroupStatus.PAUSED,
        type: enums.AdGroupType.SEARCH_STANDARD,
        cpc_bid_micros: ag.cpcBidMicros,
      },
    });
    for (const kw of ag.keywords) {
      ops.push({
        entity: 'ad_group_criterion',
        operation: 'create',
        resource: {
          ad_group: adGroupRn,
          status: enums.AdGroupCriterionStatus.ENABLED,
          keyword: { text: kw.text, match_type: enums.KeywordMatchType[kw.matchType] },
        },
      });
    }
    ops.push({
      entity: 'ad_group_ad',
      operation: 'create',
      resource: {
        ad_group: adGroupRn,
        status: enums.AdGroupAdStatus.PAUSED,
        ad: {
          type: enums.AdType.RESPONSIVE_SEARCH_AD,
          final_urls: [ag.finalUrl],
          responsive_search_ad: {
            headlines: ag.headlines.map((text) => ({ text })),
            descriptions: ag.descriptions.map((text) => ({ text })),
          },
        },
      },
    });
  }

  for (const s of payload.sitelinks) {
    const assetRn = ResourceNames.asset(customerId, nextTemp());
    ops.push({
      entity: 'asset',
      operation: 'create',
      resource: {
        resource_name: assetRn,
        name: s.linkText,
        type: enums.AssetType.SITELINK,
        final_urls: [s.finalUrl],
        sitelink_asset: { link_text: s.linkText, description1: s.description1, description2: s.description2 },
      },
    });
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignRn, asset: assetRn, field_type: enums.AssetFieldType.SITELINK },
    });
  }
  for (const text of payload.callouts) {
    const assetRn = ResourceNames.asset(customerId, nextTemp());
    ops.push({
      entity: 'asset',
      operation: 'create',
      resource: { resource_name: assetRn, name: text, type: enums.AssetType.CALLOUT, callout_asset: { callout_text: text } },
    });
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignRn, asset: assetRn, field_type: enums.AssetFieldType.CALLOUT },
    });
  }
  if (payload.call) {
    const assetRn = ResourceNames.asset(customerId, nextTemp());
    ops.push({
      entity: 'asset',
      operation: 'create',
      resource: {
        resource_name: assetRn,
        name: `${payload.call.countryCode} ${payload.call.phoneNumber}`,
        type: enums.AssetType.CALL,
        call_asset: { country_code: payload.call.countryCode, phone_number: payload.call.phoneNumber },
      },
    });
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignRn, asset: assetRn, field_type: enums.AssetFieldType.CALL },
    });
  }

  return customer.mutateResources(ops as any);
}

export interface DisplayCampaignFullPayload {
  campaignName: string;
  dailyBudgetMicros: number;
  status: 'PAUSED' | 'ENABLED';
  bidding: SearchCampaignBidding;
  locationCriterionIds: string[];
  languageCriterionIds: string[];
  positiveGeoTargetType: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
  adGroup: { name: string; cpcBidMicros: number; optimizedTargetingEnabled?: boolean };
  ad: {
    businessName: string;
    headlines: string[];
    longHeadline: string;
    descriptions: string[];
    finalUrl: string;
    marketingImageAssetIds: string[];
    squareMarketingImageAssetIds: string[];
    logoImageAssetIds: string[];
  };
}

export async function createDisplayCampaignFull(
  cfg: AdsConfig,
  customerId: string,
  payload: DisplayCampaignFullPayload,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  let temp = 0;
  const nextTemp = () => String(--temp);
  const ops: any[] = [];

  const budgetRn = ResourceNames.campaignBudget(customerId, nextTemp());
  ops.push({
    entity: 'campaign_budget',
    operation: 'create',
    resource: {
      resource_name: budgetRn,
      name: `${payload.campaignName} Budget`,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
      amount_micros: payload.dailyBudgetMicros,
    },
  });

  const campaignRn = ResourceNames.campaign(customerId, nextTemp());
  ops.push({
    entity: 'campaign',
    operation: 'create',
    resource: {
      resource_name: campaignRn,
      name: payload.campaignName,
      advertising_channel_type: enums.AdvertisingChannelType.DISPLAY,
      status: enums.CampaignStatus[payload.status],
      campaign_budget: budgetRn,
      ...searchCampaignBiddingResource(payload.bidding),
      geo_target_type_setting: {
        positive_geo_target_type: (enums.PositiveGeoTargetType as any)[payload.positiveGeoTargetType],
      },
      contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
    },
  });

  for (const id of payload.locationCriterionIds) {
    ops.push({ entity: 'campaign_criterion', operation: 'create', resource: { campaign: campaignRn, location: { geo_target_constant: ResourceNames.geoTargetConstant(id) } } });
  }
  for (const id of payload.languageCriterionIds) {
    ops.push({ entity: 'campaign_criterion', operation: 'create', resource: { campaign: campaignRn, language: { language_constant: ResourceNames.languageConstant(id) } } });
  }

  const adGroupRn = ResourceNames.adGroup(customerId, nextTemp());
  const adGroupResource: Record<string, any> = {
    resource_name: adGroupRn,
    name: payload.adGroup.name,
    campaign: campaignRn,
    status: enums.AdGroupStatus.PAUSED,
    type: enums.AdGroupType.DISPLAY_STANDARD,
    cpc_bid_micros: payload.adGroup.cpcBidMicros,
  };
  if (payload.adGroup.optimizedTargetingEnabled !== undefined) {
    adGroupResource.optimized_targeting_enabled = payload.adGroup.optimizedTargetingEnabled;
  }
  ops.push({ entity: 'ad_group', operation: 'create', resource: adGroupResource });

  ops.push({
    entity: 'ad_group_ad',
    operation: 'create',
    resource: {
      ad_group: adGroupRn,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        type: enums.AdType.RESPONSIVE_DISPLAY_AD,
        final_urls: [payload.ad.finalUrl],
        responsive_display_ad: {
          business_name: payload.ad.businessName,
          headlines: payload.ad.headlines.map((text) => ({ text })),
          long_headline: { text: payload.ad.longHeadline },
          descriptions: payload.ad.descriptions.map((text) => ({ text })),
          marketing_images: payload.ad.marketingImageAssetIds.map((assetId) => ({ asset: ResourceNames.asset(customerId, assetId) })),
          square_marketing_images: payload.ad.squareMarketingImageAssetIds.map((assetId) => ({ asset: ResourceNames.asset(customerId, assetId) })),
          logo_images: payload.ad.logoImageAssetIds.map((assetId) => ({ asset: ResourceNames.asset(customerId, assetId) })),
        },
      },
    },
  });

  return customer.mutateResources(ops as any);
}

const PMAX_AI_OPT_OUT_TYPES = ['TEXT_ASSET_AUTOMATION', 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION'];

export interface PerformanceMaxCampaignFullPayload {
  campaignName: string;
  dailyBudgetMicros: number;
  status: 'PAUSED' | 'ENABLED';
  targetRoas?: number;
  optOutAiEnhancements: boolean;
  assetGroupName: string;
  finalUrls: string[];
  businessName?: string;
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
  imageAssets: Array<{ assetId: string; fieldType: string }>;
  audienceSignals: Array<{ type: 'SEARCH_THEME'; text: string } | { type: 'AUDIENCE'; audienceId: string }>;
}

export async function createPerformanceMaxCampaignFull(
  cfg: AdsConfig,
  customerId: string,
  payload: PerformanceMaxCampaignFullPayload,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  let temp = 0;
  const nextTemp = () => String(--temp);
  const ops: any[] = [];

  const budgetRn = ResourceNames.campaignBudget(customerId, nextTemp());
  ops.push({
    entity: 'campaign_budget',
    operation: 'create',
    resource: {
      resource_name: budgetRn,
      name: `${payload.campaignName} Budget`,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
      amount_micros: payload.dailyBudgetMicros,
    },
  });

  const campaignRn = ResourceNames.campaign(customerId, nextTemp());
  const campaignResource: Record<string, any> = {
    resource_name: campaignRn,
    name: payload.campaignName,
    advertising_channel_type: enums.AdvertisingChannelType.PERFORMANCE_MAX,
    status: enums.CampaignStatus[payload.status],
    campaign_budget: budgetRn,
    maximize_conversion_value: payload.targetRoas ? { target_roas: payload.targetRoas } : {},
    contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
  };
  if (payload.optOutAiEnhancements) {
    campaignResource.asset_automation_settings = PMAX_AI_OPT_OUT_TYPES.map((t) => ({
      asset_automation_type: (enums.AssetAutomationType as any)[t],
      asset_automation_status: enums.AssetAutomationStatus.OPTED_OUT,
    }));
  }
  ops.push({ entity: 'campaign', operation: 'create', resource: campaignResource });

  const assetGroupRn = ResourceNames.assetGroup(customerId, nextTemp());
  ops.push({
    entity: 'asset_group',
    operation: 'create',
    resource: {
      resource_name: assetGroupRn,
      campaign: campaignRn,
      name: payload.assetGroupName,
      final_urls: payload.finalUrls,
      status: enums.AssetGroupStatus.PAUSED,
    },
  });

  const pushTextAsset = (text: string, fieldType: string) => {
    const assetRn = ResourceNames.asset(customerId, nextTemp());
    ops.push({ entity: 'asset', operation: 'create', resource: { resource_name: assetRn, type: enums.AssetType.TEXT, text_asset: { text } } });
    ops.push({ entity: 'asset_group_asset', operation: 'create', resource: { asset_group: assetGroupRn, asset: assetRn, field_type: (enums.AssetFieldType as any)[fieldType] } });
  };
  for (const text of payload.headlines) pushTextAsset(text, 'HEADLINE');
  for (const text of payload.longHeadlines) pushTextAsset(text, 'LONG_HEADLINE');
  for (const text of payload.descriptions) pushTextAsset(text, 'DESCRIPTION');
  if (payload.businessName) pushTextAsset(payload.businessName, 'BUSINESS_NAME');

  for (const image of payload.imageAssets) {
    ops.push({
      entity: 'asset_group_asset',
      operation: 'create',
      resource: { asset_group: assetGroupRn, asset: ResourceNames.asset(customerId, image.assetId), field_type: (enums.AssetFieldType as any)[image.fieldType] },
    });
  }

  for (const signal of payload.audienceSignals) {
    if (signal.type === 'SEARCH_THEME') {
      ops.push({ entity: 'asset_group_signal', operation: 'create', resource: { asset_group: assetGroupRn, search_theme: { text: signal.text } } });
    } else {
      ops.push({ entity: 'asset_group_signal', operation: 'create', resource: { asset_group: assetGroupRn, audience: { audience: ResourceNames.audience(customerId, signal.audienceId) } } });
    }
  }

  return customer.mutateResources(ops as any);
}
