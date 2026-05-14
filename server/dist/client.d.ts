import type { AdsConfig } from './config.js';
export declare function listAccounts(cfg: AdsConfig): Promise<Array<{
    id: string;
    name: string;
    currency: string;
}>>;
export declare function getCampaigns(cfg: AdsConfig, customerId: string, days?: 7 | 30): Promise<unknown[]>;
export declare function executeGaql(cfg: AdsConfig, customerId: string, query: string): Promise<unknown[]>;
export declare function mutateCampaignStatus(cfg: AdsConfig, customerId: string, campaignId: string, status: 'ENABLED' | 'PAUSED'): Promise<unknown>;
export declare function mutateCampaignStatuses(cfg: AdsConfig, customerId: string, campaigns: Array<{
    campaignId: string;
    status: 'ENABLED' | 'PAUSED';
}>): Promise<unknown>;
export declare function removeCampaigns(cfg: AdsConfig, customerId: string, campaignIds: string[]): Promise<unknown>;
export declare function mutateCampaignBudget(cfg: AdsConfig, customerId: string, budgetId: string, amountMicros: number): Promise<unknown>;
export declare function createSearchCampaign(cfg: AdsConfig, customerId: string, name: string, dailyBudgetMicros: number): Promise<unknown>;
export declare function createAdGroup(cfg: AdsConfig, customerId: string, campaignId: string, name: string, cpcBidMicros: number): Promise<unknown>;
export declare function createResponsiveSearchAd(cfg: AdsConfig, customerId: string, adGroupId: string, headlines: string[], descriptions: string[], finalUrl: string): Promise<unknown>;
