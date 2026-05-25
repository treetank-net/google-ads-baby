import { GoogleAdsApi, enums, ResourceNames } from 'google-ads-api';
import type { AdsConfig } from '../config.js';

export { enums, ResourceNames };

export function getCustomer(cfg: AdsConfig, customerId: string) {
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
