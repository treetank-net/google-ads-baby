import { GoogleAdsApi, enums, ResourceNames } from 'google-ads-api';
import { readFileSync, statSync } from 'fs';
import type { AdsConfig } from './config.js';

function getCustomer(cfg: AdsConfig, customerId: string) {
  const api = new GoogleAdsApi({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    developer_token: cfg.developerToken,
  });
  return api.Customer({
    customer_id: customerId,
    login_customer_id: cfg.loginCustomerId,
    refresh_token: cfg.refreshToken,
  });
}

export async function listAccounts(cfg: AdsConfig): Promise<Array<{ id: string; name: string; currency: string }>> {
  const customer = getCustomer(cfg, cfg.loginCustomerId);
  const rows = await customer.query(`
    SELECT customer_client.id, customer_client.descriptive_name,
           customer_client.currency_code, customer_client.manager,
           customer_client.status
    FROM customer_client
    WHERE customer_client.status = 'ENABLED'
      AND customer_client.manager = false
    ORDER BY customer_client.descriptive_name
  `);
  return rows.map((r: any) => ({
    id: String(r.customer_client?.id),
    name: r.customer_client?.descriptive_name,
    currency: r.customer_client?.currency_code,
  }));
}

export async function getCampaigns(cfg: AdsConfig, customerId: string, days: 7 | 30 = 30): Promise<unknown[]> {
  const customer = getCustomer(cfg, customerId);
  return customer.query(`
    SELECT campaign.id, campaign.name, campaign.status,
           campaign.advertising_channel_type,
           metrics.impressions, metrics.clicks, metrics.ctr,
           metrics.cost_micros, metrics.conversions,
           metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING LAST_${days}_DAYS
      AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC
  `);
}

export async function executeGaql(cfg: AdsConfig, customerId: string, query: string): Promise<unknown[]> {
  const customer = getCustomer(cfg, customerId);
  return customer.query(query);
}

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

export async function uploadImageAssetFromUrl(
  cfg: AdsConfig,
  customerId: string,
  assetName: string,
  imageUrl: string,
  maxImageBytes: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status} from ${imageUrl}`);
  }

  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
    throw new Error(`Image is too large (${contentLength} bytes). Max allowed: ${maxImageBytes} bytes.`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`URL does not look like an image (content-type: ${contentType || 'unknown'}).`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) {
    throw new Error('Downloaded image is empty.');
  }
  if (data.length > maxImageBytes) {
    throw new Error(`Image is too large (${data.length} bytes). Max allowed: ${maxImageBytes} bytes.`);
  }

  return customer.assets.create([
    {
      name: assetName,
      image_asset: { data },
    } as any,
  ]);
}

export async function uploadImageAssetFromFile(
  cfg: AdsConfig,
  customerId: string,
  assetName: string,
  filePath: string,
  maxImageBytes: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }
  if (st.size <= 0) {
    throw new Error(`File is empty: ${filePath}`);
  }
  if (st.size > maxImageBytes) {
    throw new Error(`File is too large (${st.size} bytes). Max allowed: ${maxImageBytes} bytes.`);
  }

  const data = readFileSync(filePath);
  if (!data.length) {
    throw new Error(`File is empty: ${filePath}`);
  }

  return customer.assets.create([
    {
      name: assetName,
      image_asset: { data },
    } as any,
  ]);
}
