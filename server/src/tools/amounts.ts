import type { AdsConfig } from '../config.js';
import { getAccountCurrency } from '../client.js';

export const MICROS_PER_UNIT = 1_000_000;

export const DEFAULT_MAX_BUDGET_UNITS = 500;
export const DEFAULT_MAX_CPC_UNITS = 50;
export const DEFAULT_MAX_TARGET_CPA_UNITS = 500;

export const UNKNOWN_CURRENCY_SCALE = 1;

export const CURRENCY_UNIT_SCALE: Record<string, number> = {
  PLN: 1,
  EUR: 0.25,
  USD: 0.25,
  GBP: 0.25,
  CHF: 0.25,
  BGN: 0.5,
  RON: 1.25,
  DKK: 2,
  SEK: 2.5,
  NOK: 2.5,
  CZK: 5,
  UAH: 10,
  HUF: 100,
};

export interface AmountLimits {
  currency: string;
  budgetMicros: number;
  cpcMicros: number;
  targetCpaMicros: number;
}

export function currencyUnitScale(currency: string): number {
  return CURRENCY_UNIT_SCALE[currency.trim().toUpperCase()] ?? UNKNOWN_CURRENCY_SCALE;
}

function configuredUnits(value: string | undefined): number | null {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveAmountLimits(cfg: AdsConfig, currency: string): AmountLimits {
  const scale = currencyUnitScale(currency);
  const cap = (defaultUnits: number, configured: string | undefined) =>
    Math.round((configuredUnits(configured) ?? defaultUnits * scale) * MICROS_PER_UNIT);
  return {
    currency: currency.trim().toUpperCase(),
    budgetMicros: cap(DEFAULT_MAX_BUDGET_UNITS, cfg.maxDailyBudgetUnits),
    cpcMicros: cap(DEFAULT_MAX_CPC_UNITS, cfg.maxCpcUnits),
    targetCpaMicros: cap(DEFAULT_MAX_TARGET_CPA_UNITS, cfg.maxTargetCpaUnits),
  };
}

export async function loadAmountLimits(cfg: AdsConfig, customerId: string): Promise<AmountLimits> {
  return resolveAmountLimits(cfg, await getAccountCurrency(cfg, customerId));
}

export function amountToMicros(units: number): number {
  return Math.round(units * MICROS_PER_UNIT);
}

export function formatUnits(units: number, currency: string): string {
  const rendered = Number.isInteger(units) ? String(units) : units.toFixed(2);
  return currency ? `${rendered} ${currency}` : `${rendered} account currency unit(s)`;
}

export function formatAmount(micros: number | undefined | null, currency: string): string {
  if (micros === undefined || micros === null) return '(not set)';
  return formatUnits(Number((micros / MICROS_PER_UNIT).toFixed(2)), currency);
}

export function amountFieldDescription(purpose: string): string {
  return `${purpose} in account currency units (the account currency is shown by list_accounts); capped by the server safety limit`;
}
