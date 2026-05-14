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
export declare function createDisplayCampaign(cfg: AdsConfig, customerId: string, name: string, dailyBudgetMicros: number): Promise<unknown>;
export declare function createPerformanceMaxCampaign(cfg: AdsConfig, customerId: string, name: string, dailyBudgetMicros: number, brandAssets?: {
    businessNameAssetId?: string;
    logoAssetId?: string;
}): Promise<unknown>;
export declare function createAdGroup(cfg: AdsConfig, customerId: string, campaignId: string, name: string, cpcBidMicros: number): Promise<unknown>;
export declare function createDisplayAdGroup(cfg: AdsConfig, customerId: string, campaignId: string, name: string, cpcBidMicros: number): Promise<unknown>;
export declare function createResponsiveSearchAd(cfg: AdsConfig, customerId: string, adGroupId: string, headlines: string[], descriptions: string[], finalUrl: string): Promise<unknown>;
export declare function createKeywords(cfg: AdsConfig, customerId: string, adGroupId: string, keywords: Array<{
    text: string;
    matchType: 'BROAD' | 'PHRASE' | 'EXACT';
}>): Promise<unknown>;
export declare function createNegativeKeywords(cfg: AdsConfig, customerId: string, target: {
    level: 'campaign';
    campaignId: string;
} | {
    level: 'ad_group';
    adGroupId: string;
}, keywords: Array<{
    text: string;
    matchType: 'BROAD' | 'PHRASE' | 'EXACT';
}>): Promise<unknown>;
export declare function createCampaignTargeting(cfg: AdsConfig, customerId: string, campaignId: string, targeting: {
    locationCriterionIds: string[];
    languageCriterionIds: string[];
}): Promise<unknown>;
export declare function createAssetGroup(cfg: AdsConfig, customerId: string, campaignId: string, name: string, finalUrls: string[]): Promise<unknown>;
export declare function createAssetGroupAssets(cfg: AdsConfig, customerId: string, assetGroupId: string, assets: Array<{
    assetId: string;
    fieldType: string;
}>): Promise<unknown>;
export declare function createResponsiveDisplayAd(cfg: AdsConfig, customerId: string, adGroupId: string, businessName: string, headlines: string[], longHeadline: string, descriptions: string[], finalUrl: string, marketingImageAssetIds: string[], squareMarketingImageAssetIds: string[], logoImageAssetIds: string[]): Promise<unknown>;
export declare function uploadImageAssetFromUrl(cfg: AdsConfig, customerId: string, assetName: string, imageUrl: string, maxImageBytes: number): Promise<unknown>;
export declare function uploadImageAssetFromFile(cfg: AdsConfig, customerId: string, assetName: string, filePath: string, maxImageBytes: number): Promise<unknown>;
