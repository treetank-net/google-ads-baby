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
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.adGroups.create([
    {
      name,
      campaign: ResourceNames.campaign(customerId, campaignId),
      status: enums.AdGroupStatus.PAUSED,
      type: enums.AdGroupType.DISPLAY_STANDARD,
      cpc_bid_micros: cpcBidMicros,
    } as any,
  ]);
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
