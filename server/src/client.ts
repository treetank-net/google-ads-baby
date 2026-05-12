import { GoogleAdsApi, enums, ResourceNames } from 'google-ads-api';
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
  const customer = getCustomer(cfg, customerId);
  return customer.campaigns.update([
    {
      resource_name: `customers/${customerId}/campaigns/${campaignId}`,
      status: enums.CampaignStatus[status],
    },
  ]);
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
