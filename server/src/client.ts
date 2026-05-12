import { GoogleAdsApi } from 'google-ads-api';

export interface AdsConfig {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  loginCustomerId: string;
}

export function configFromEnv(): AdsConfig {
  const required = (key: string) => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing env var: ${key}`);
    return val;
  };
  return {
    clientId: required('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: required('GOOGLE_ADS_CLIENT_SECRET'),
    developerToken: required('GOOGLE_ADS_DEVELOPER_TOKEN'),
    refreshToken: required('GOOGLE_ADS_REFRESH_TOKEN'),
    loginCustomerId: required('GOOGLE_ADS_MCC_ID'),
  };
}

function api(cfg: AdsConfig) {
  return new GoogleAdsApi({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    developer_token: cfg.developerToken,
  });
}

function customer(cfg: AdsConfig, customerId: string) {
  return api(cfg).Customer({
    customer_id: customerId,
    login_customer_id: cfg.loginCustomerId,
    refresh_token: cfg.refreshToken,
  });
}

export async function listAccounts(cfg: AdsConfig) {
  const c = customer(cfg, cfg.loginCustomerId);
  const rows = await c.query(`
    SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code,
           customer_client.manager, customer_client.status
    FROM customer_client
    WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false
    ORDER BY customer_client.descriptive_name
  `);
  return rows.map((r: any) => ({
    id: String(r.customer_client.id),
    name: r.customer_client.descriptive_name,
    currency: r.customer_client.currency_code,
  }));
}

export async function executeGaql(cfg: AdsConfig, customerId: string, query: string) {
  const c = customer(cfg, customerId);
  return c.query(query);
}

export async function getCampaigns(cfg: AdsConfig, customerId: string, days: 7 | 30 = 30) {
  const c = customer(cfg, customerId);
  return c.query(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING LAST_${days}_DAYS AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC
  `);
}

export async function mutateCampaignStatus(cfg: AdsConfig, customerId: string, campaignId: string, status: 'ENABLED' | 'PAUSED') {
  const c = customer(cfg, customerId);
  return c.campaignBudgets.update({
    entity: { resource_name: `customers/${customerId}/campaigns/${campaignId}`, status },
    update_mask: { paths: ['status'] },
  } as any);
}

export async function mutateCampaignBudget(cfg: AdsConfig, customerId: string, budgetId: string, amountMicros: number) {
  const c = customer(cfg, customerId);
  return c.campaignBudgets.update({
    entity: { resource_name: `customers/${customerId}/campaignBudgets/${budgetId}`, amount_micros: amountMicros },
    update_mask: { paths: ['amount_micros'] },
  } as any);
}
