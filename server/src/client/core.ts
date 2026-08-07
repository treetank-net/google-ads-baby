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

const accountCurrencyCache = new Map<string, string>();

export async function getAccountCurrency(cfg: AdsConfig, customerId: string): Promise<string> {
  const cached = accountCurrencyCache.get(customerId);
  if (cached) return cached;
  if (!cfg.refreshToken || !cfg.developerToken) return '';
  try {
    const rows = await executeGaql(cfg, customerId, 'SELECT customer.currency_code FROM customer LIMIT 1') as any[];
    const currency = String(rows[0]?.customer?.currency_code ?? '').toUpperCase();
    if (currency) accountCurrencyCache.set(customerId, currency);
    return currency;
  } catch {
    return '';
  }
}

export async function executeGaql(cfg: AdsConfig, customerId: string, query: string): Promise<unknown[]> {
  const customer = getCustomer(cfg, customerId);
  return customer.query(query);
}
