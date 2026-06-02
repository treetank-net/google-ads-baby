import { enums, ResourceNames } from 'google-ads-api';
import { getCustomer } from './core.js';
import type { AdsConfig } from '../config.js';

export async function createResponsiveSearchAd(
  cfg: AdsConfig,
  customerId: string,
  adGroupId: string,
  headlines: string[],
  descriptions: string[],
  finalUrl: string,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.adGroupAds.create([
    {
      ad_group: ResourceNames.adGroup(customerId, adGroupId),
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        type: enums.AdType.RESPONSIVE_SEARCH_AD,
        final_urls: [finalUrl],
        responsive_search_ad: {
          headlines: headlines.map((text) => ({ text })),
          descriptions: descriptions.map((text) => ({ text })),
        },
      },
    } as any,
  ]);
}

export async function createResponsiveDisplayAd(
  cfg: AdsConfig,
  customerId: string,
  adGroupId: string,
  businessName: string,
  headlines: string[],
  longHeadline: string,
  descriptions: string[],
  finalUrl: string,
  marketingImageAssetIds: string[],
  squareMarketingImageAssetIds: string[],
  logoImageAssetIds: string[],
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);

  return customer.adGroupAds.create([
    {
      ad_group: ResourceNames.adGroup(customerId, adGroupId),
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        type: enums.AdType.RESPONSIVE_DISPLAY_AD,
        final_urls: [finalUrl],
        responsive_display_ad: {
          business_name: businessName,
          headlines: headlines.map((text) => ({ text })),
          long_headline: { text: longHeadline },
          descriptions: descriptions.map((text) => ({ text })),
          marketing_images: marketingImageAssetIds.map((assetId) => ({
            asset: ResourceNames.asset(customerId, assetId),
          })),
          square_marketing_images: squareMarketingImageAssetIds.map((assetId) => ({
            asset: ResourceNames.asset(customerId, assetId),
          })),
          logo_images: logoImageAssetIds.map((assetId) => ({
            asset: ResourceNames.asset(customerId, assetId),
          })),
        },
      },
    } as any,
  ]);
}

export async function createKeywords(
  cfg: AdsConfig,
  customerId: string,
  adGroupId: string,
  keywords: Array<{ text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.adGroupCriteria.create(keywords.map((keyword) => ({
    ad_group: ResourceNames.adGroup(customerId, adGroupId),
    status: enums.AdGroupCriterionStatus.ENABLED,
    keyword: {
      text: keyword.text,
      match_type: enums.KeywordMatchType[keyword.matchType],
    },
  }) as any));
}

export async function mutateKeywordStatus(
  cfg: AdsConfig,
  customerId: string,
  operations: Array<{ adGroupId: string; criterionId: string; status: 'ENABLED' | 'PAUSED' | 'REMOVED' }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const updates = operations.filter(op => op.status !== 'REMOVED');
  const removes = operations.filter(op => op.status === 'REMOVED');
  const results: unknown[] = [];
  if (updates.length) {
    results.push(await customer.adGroupCriteria.update(updates.map(op => ({
      resource_name: `customers/${customerId}/adGroupCriteria/${op.adGroupId}~${op.criterionId}`,
      status: enums.AdGroupCriterionStatus[op.status],
    }))));
  }
  if (removes.length) {
    results.push(await customer.adGroupCriteria.remove(
      removes.map(op => `customers/${customerId}/adGroupCriteria/${op.adGroupId}~${op.criterionId}`),
    ));
  }
  return results.length === 1 ? results[0] : results;
}

export async function mutateAdStatus(
  cfg: AdsConfig,
  customerId: string,
  adGroupId: string,
  adId: string,
  status: 'ENABLED' | 'PAUSED',
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.adGroupAds.update([{
    resource_name: `customers/${customerId}/adGroupAds/${adGroupId}~${adId}`,
    status: enums.AdGroupAdStatus[status],
  }]);
}

export async function createNegativeKeywords(
  cfg: AdsConfig,
  customerId: string,
  target: { level: 'campaign'; campaignId: string } | { level: 'ad_group'; adGroupId: string },
  keywords: Array<{ text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  if (target.level === 'campaign') {
    return customer.campaignCriteria.create(keywords.map((keyword) => ({
      campaign: ResourceNames.campaign(customerId, target.campaignId),
      negative: true,
      keyword: {
        text: keyword.text,
        match_type: enums.KeywordMatchType[keyword.matchType],
      },
    }) as any));
  }

  return customer.adGroupCriteria.create(keywords.map((keyword) => ({
    ad_group: ResourceNames.adGroup(customerId, target.adGroupId),
    negative: true,
    keyword: {
      text: keyword.text,
      match_type: enums.KeywordMatchType[keyword.matchType],
    },
  }) as any));
}
